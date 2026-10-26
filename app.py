"""Excelarate: Excel <-> CSV converter (Flask + Polars)."""
from __future__ import annotations

import csv
import io
import json
import operator
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import date, datetime
from functools import reduce
from pathlib import Path
from urllib.parse import quote

import polars as pl
from flask import Flask, abort, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException
from xlsxwriter import Workbook

try:  # Polars can raise PanicException, which is not a subclass of Exception
    from polars.exceptions import PanicException
except Exception:  # pragma: no cover
    PanicException = Exception
CATCH = (Exception, PanicException)

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("GLASS_DATA_DIR", Path(tempfile.gettempdir()) / "Excelarate"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
TTL_SECONDS = int(os.environ.get("GLASS_TTL_HOURS", "2")) * 3600
MAX_UPLOAD_MB = int(os.environ.get("GLASS_MAX_UPLOAD_MB", "500"))
PICK_LIMIT = 300  # text columns with up to this many distinct values get a checklist
MAX_XLSX_ROWS = 1_048_576  # Excel's limit per sheet, header row included
BLANK = "(blank)"
DELIMS = {"comma": ",", "semicolon": ";", "tab": "\t", "pipe": "|"}
SYMBOL_TO_NAME = {v: k for k, v in DELIMS.items()}
ID_RE = re.compile(r"^[0-9a-f]{32}$")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
app.json.sort_keys = False


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(e: ApiError):
    return jsonify({"error": e.message}), e.status


@app.errorhandler(HTTPException)
def handle_http_error(e: HTTPException):
    if not request.path.startswith("/api/"):
        return e
    messages = {
        404: "This file is no longer on the server. Upload it again.",
        413: f"That file is too large. The limit is {MAX_UPLOAD_MB} MB.",
    }
    return jsonify({"error": messages.get(e.code, e.description)}), e.code


@app.errorhandler(Exception)
def handle_unexpected(e: Exception):
    if isinstance(e, HTTPException):
        return handle_http_error(e)
    if request.path.startswith("/api/"):
        app.logger.exception("Unhandled error")
        return jsonify({"error": f"Something went wrong on the server: {e}"}), 500
    raise e


# ----------------------------------------------------------------------------
# Storage helpers
# ----------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
SHEET_CACHE: dict[tuple[str, int], pl.DataFrame] = {}
CACHE_MAX = 3
_cache_lock = threading.Lock()
_cleanup_lock = threading.Lock()


def new_id() -> str:
    return uuid.uuid4().hex


def safe_name(text) -> str:
    return re.sub(r'[\\/*?:"<>|]+', "_", str(text)).strip() or "file"


def entry_dir(prefix: str, entry_id: str) -> Path:
    if not ID_RE.match(entry_id or ""):
        abort(404)
    d = DATA_DIR / f"{prefix}_{entry_id}"
    if not d.is_dir():
        abort(404)
    try:
        os.utime(d, None)  # keep active sessions alive
    except OSError:
        pass
    return d


def load_meta(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text(encoding="utf-8"))


def cleanup_old() -> None:
    now = time.time()
    with _cleanup_lock:
        for child in DATA_DIR.iterdir():
            try:
                if now - child.stat().st_mtime > TTL_SECONDS:
                    if child.is_dir():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink(missing_ok=True)
            except OSError:
                pass
        with JOBS_LOCK:
            for jid in [j for j, v in JOBS.items() if now - v["created"] > TTL_SECONDS]:
                del JOBS[jid]
        with _cache_lock:
            SHEET_CACHE.clear()


def get_sheet(eid: str, idx: int):
    d = entry_dir("x", eid)
    meta = load_meta(d)
    if not 0 <= idx < len(meta["sheets"]):
        abort(404)
    key = (eid, idx)
    with _cache_lock:
        df = SHEET_CACHE.pop(key, None)
        if df is not None:
            SHEET_CACHE[key] = df  # move to the end (most recently used)
            return meta, df
    path = d / f"sheet_{idx}.parquet"
    df = pl.read_parquet(path) if path.exists() else pl.DataFrame()
    with _cache_lock:
        SHEET_CACHE[key] = df
        while len(SHEET_CACHE) > CACHE_MAX:
            SHEET_CACHE.pop(next(iter(SHEET_CACHE)))
    return meta, df


# ----------------------------------------------------------------------------
# Data helpers
# ----------------------------------------------------------------------------
def kind_of(dtype) -> str:
    try:
        if dtype == pl.Date or dtype == pl.Datetime:
            return "date"
        if dtype.is_numeric():
            return "number"
    except CATCH:
        pass
    return "text"


def as_text(s: pl.Series) -> pl.Series:
    try:
        if s.dtype == pl.Datetime:
            return s.dt.strftime("%Y-%m-%d %H:%M:%S")
        return s.cast(pl.String)
    except CATCH:
        return pl.Series(values=[None if v is None else str(v) for v in s.to_list()], dtype=pl.String)


def to_text_rows(df: pl.DataFrame) -> list[list]:
    if df.height == 0 or df.width == 0:
        return []
    cols = [as_text(df[c]).to_list() for c in df.columns]
    return [list(r) for r in zip(*cols)]


def csv_bytes(df: pl.DataFrame, sep: str, header: bool, bom: bool) -> bytes:
    if df.width == 0:
        return b""
    buf = io.BytesIO()
    df.write_csv(buf, separator=sep, include_header=header, include_bom=bom)
    return buf.getvalue()


def _num(v):
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ValueError(f"'{v}' is not a number.")


def _day(v):
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise ValueError(f"'{v}' is not a valid date.")


def build_filter(df: pl.DataFrame, spec: dict):
    """Turn the filter spec sent by the browser into one Polars expression (or None)."""
    conds = []
    q = str(spec.get("search") or "").strip().lower()
    if q and df.width:
        conds.append(
            pl.any_horizontal(
                [pl.col(c).cast(pl.String).str.to_lowercase().str.contains(q, literal=True).fill_null(False) for c in df.columns]
            )
        )

    for f in spec.get("filters") or []:
        col = f.get("col")
        if col not in df.columns:
            continue
        actual = kind_of(df.schema[col])
        kind = f.get("kind")
        c = pl.col(col)

        if kind == "number" and actual == "number":
            lo, hi = _num(f.get("min")), _num(f.get("max"))
            if lo is not None:
                conds.append(c >= lo)
            if hi is not None:
                conds.append(c <= hi)

        elif kind == "date" and actual == "date":
            lo, hi = _day(f.get("start")), _day(f.get("end"))
            d = c.cast(pl.Date)
            if lo is not None:
                conds.append(d >= lo)
            if hi is not None:
                conds.append(d <= hi)

        elif kind == "values":
            vals = [str(v) for v in (f.get("values") or [])]
            if not vals:
                continue
            wanted = [v for v in vals if v != BLANK]
            cond = c.cast(pl.String).is_in(wanted) if wanted else pl.lit(False)
            if BLANK in vals:
                cond = cond | c.is_null()
            conds.append(cond)

        elif kind == "text":
            text = str(f.get("text") or "").lower()
            if not text:
                continue
            e = c.cast(pl.String).str.to_lowercase()
            mode = f.get("mode")
            if mode == "equals":
                conds.append(e == text)
            elif mode == "starts with":
                conds.append(e.str.starts_with(text))
            elif mode == "ends with":
                conds.append(e.str.ends_with(text))
            else:
                conds.append(e.str.contains(text, literal=True))

    return reduce(operator.and_, conds) if conds else None


def apply_spec(df: pl.DataFrame, spec: dict, sort: bool = True) -> pl.DataFrame:
    try:
        cond = build_filter(df, spec)
        out = df.filter(cond) if cond is not None else df
        s = spec.get("sort")
        if sort and isinstance(s, dict) and s.get("col") in out.columns:
            out = out.sort(s["col"], descending=bool(s.get("desc")), nulls_last=True)
        return out
    except ValueError as e:
        raise ApiError(str(e))
    except CATCH as e:
        raise ApiError(f"Could not apply the filters: {e}")


# ----------------------------------------------------------------------------
# Pages
# ----------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html", max_mb=MAX_UPLOAD_MB)


# ----------------------------------------------------------------------------
# Excel -> CSV API
# ----------------------------------------------------------------------------
def read_all_sheets(path: Path) -> dict[str, pl.DataFrame]:
    kwargs = dict(sheet_id=0, infer_schema_length=None)  # sheet_id=0 reads every sheet
    try:
        return pl.read_excel(path, raise_if_empty=False, **kwargs)
    except TypeError:  # older Polars without raise_if_empty
        return pl.read_excel(path, **kwargs)


@app.post("/api/excel/upload")
def excel_upload():
    cleanup_old()
    f = request.files.get("file")
    if not f or not f.filename:
        raise ApiError("No file was received.")
    ext = Path(f.filename).suffix.lower()
    if ext not in {".xlsx", ".xlsm", ".xls"}:
        raise ApiError("Choose an .xlsx, .xlsm or .xls file.")

    eid = new_id()
    d = DATA_DIR / f"x_{eid}"
    d.mkdir(parents=True)
    src = d / f"source{ext}"
    f.save(src)
    try:
        sheets = read_all_sheets(src)
        meta = {"filename": f.filename, "size": src.stat().st_size, "sheets": []}
        for i, (name, df) in enumerate(sheets.items()):
            if df.width:
                df.write_parquet(d / f"sheet_{i}.parquet")
            meta["sheets"].append({"name": name, "rows": df.height, "cols": df.width})
        (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    except CATCH as e:
        shutil.rmtree(d, ignore_errors=True)
        raise ApiError(f"Could not read this workbook: {e}")
    finally:
        src.unlink(missing_ok=True)
    return jsonify({"id": eid, **meta})


@app.get("/api/excel/<eid>/sheet/<int:idx>/columns")
def excel_columns(eid, idx):
    meta, df = get_sheet(eid, idx)
    return jsonify(
        {
            "rows": df.height,
            "columns": [{"name": c, "dtype": str(t), "kind": kind_of(t)} for c, t in zip(df.columns, df.dtypes)],
        }
    )


@app.get("/api/excel/<eid>/sheet/<int:idx>/column/<int:ci>")
def excel_column_info(eid, idx, ci):
    _, df = get_sheet(eid, idx)
    if not 0 <= ci < df.width:
        abort(404)
    s = df[df.columns[ci]]
    kind = kind_of(s.dtype)
    info = {"name": s.name, "kind": kind, "nulls": s.null_count()}
    try:
        if kind == "number":
            if s.dtype.is_float():
                s = s.filter(s.is_finite())
            lo, hi = s.min(), s.max()
            if lo is None:
                info["empty"] = True
            else:
                info["min"], info["max"] = (lo, hi) if s.dtype.is_integer() else (float(lo), float(hi))
        elif kind == "date":
            lo, hi = s.min(), s.max()
            if lo is None:
                info["empty"] = True
            else:
                info["min"] = (lo.date() if isinstance(lo, datetime) else lo).isoformat()
                info["max"] = (hi.date() if isinstance(hi, datetime) else hi).isoformat()
        else:
            values = as_text(s).drop_nulls()
            uniq = values.n_unique()
            info["unique"] = uniq
            info["empty"] = uniq == 0 and s.null_count() > 0
            info["hasBlank"] = s.null_count() > 0
            info["values"] = sorted(values.unique().to_list()) if uniq <= PICK_LIMIT else None
    except CATCH as e:
        raise ApiError(f"Could not read this column: {e}")
    return jsonify(info)


@app.post("/api/excel/<eid>/sheet/<int:idx>/query")
def excel_query(eid, idx):
    body = request.get_json(silent=True) or {}
    _, df = get_sheet(eid, idx)
    fdf = apply_spec(df, body)
    try:
        page = max(int(body.get("page", 1)), 1)
        size = min(max(int(body.get("pageSize", 100)), 10), 1000)
    except (TypeError, ValueError):
        page, size = 1, 100
    chunk = fdf.slice((page - 1) * size, size)
    return jsonify(
        {"total": df.height, "filtered": fdf.height, "page": page, "pageSize": size, "rows": to_text_rows(chunk)}
    )


@app.post("/api/excel/<eid>/sheet/<int:idx>/profile")
def excel_profile(eid, idx):
    _, df = get_sheet(eid, idx)
    fdf = apply_spec(df, request.get_json(silent=True) or {}, sort=False)
    if fdf.width == 0:
        return jsonify({"rows": 0, "columns": []})
    nulls = fdf.null_count().row(0)
    cols = []
    for c, t, n in zip(fdf.columns, fdf.dtypes, nulls):
        try:
            uniq = fdf[c].n_unique()
        except CATCH:
            uniq = None
        cols.append({"name": c, "dtype": str(t), "nulls": n, "unique": uniq})
    return jsonify({"rows": fdf.height, "columns": cols})


@app.post("/api/excel/<eid>/sheet/<int:idx>/stats")
def excel_stats(eid, idx):
    _, df = get_sheet(eid, idx)
    fdf = apply_spec(df, request.get_json(silent=True) or {}, sort=False)
    if fdf.height == 0 or fdf.width == 0:
        return jsonify({"columns": [], "rows": []})
    try:
        d = fdf.describe()
        return jsonify({"columns": d.columns, "rows": to_text_rows(d)})
    except CATCH as e:
        raise ApiError(f"Could not summarise this sheet: {e}")


@app.post("/api/excel/<eid>/sheet/<int:idx>/export")
def excel_export(eid, idx):
    body = request.get_json(silent=True) or {}
    meta, df = get_sheet(eid, idx)
    fdf = apply_spec(df, body)
    sep = DELIMS.get(str(body.get("delimiter", "comma")), ",")
    data = csv_bytes(fdf, sep, bool(body.get("header", True)), bool(body.get("bom", False)))
    name = f"{safe_name(Path(meta['filename']).stem)}_{safe_name(meta['sheets'][idx]['name'])}.csv"
    resp = send_file(io.BytesIO(data), mimetype="text/csv", as_attachment=True, download_name=name)
    resp.headers["X-Filename"] = quote(name)
    return resp


@app.get("/api/excel/<eid>/zip")
def excel_zip(eid):
    d = entry_dir("x", eid)
    meta = load_meta(d)
    sep = DELIMS.get(request.args.get("delimiter", "comma"), ",")
    header = request.args.get("header", "1") != "0"
    bom = request.args.get("bom") == "1"
    stem = safe_name(Path(meta["filename"]).stem)
    buf, used = io.BytesIO(), set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, sh in enumerate(meta["sheets"]):
            _, df = get_sheet(eid, i)
            name = f"{stem}_{safe_name(sh['name'])}.csv"
            n = 2
            while name.lower() in used:
                name = f"{stem}_{safe_name(sh['name'])}_{n}.csv"
                n += 1
            used.add(name.lower())
            zf.writestr(name, csv_bytes(df, sep, header, bom))
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{stem}_all_sheets.zip")


# ----------------------------------------------------------------------------
# CSV -> Excel
# ----------------------------------------------------------------------------
_INT_RE = r"^[+-]?\d+$"
_FLOAT_RE = r"^[+-]?(\d+\.\d*|\.\d+|\d+)$"
_LEADING_ZERO_RE = r"^[+-]?0\d"
_DATE_FORMATS = ["%Y-%m-%d"]
_DATETIME_FORMATS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"]
_MAX_SAFE_DIGITS = 15  # Excel keeps at most 15 significant digits


def _convert_column(s: pl.Series) -> pl.Series:
    """Convert a text column to int/float/date only when that cannot change the data."""
    try:
        if s.dtype != pl.String:
            return s
        t = s.str.strip_chars()
        clean = t.zip_with(t != "", pl.Series(values=[None] * t.len(), dtype=pl.String))
        vals = clean.drop_nulls()
        if vals.len() == 0:
            return s
        no_leading_zero = not vals.str.contains(_LEADING_ZERO_RE).any()
        digits_ok = vals.str.count_matches(r"\d").max() <= _MAX_SAFE_DIGITS
        if no_leading_zero and digits_ok:
            if vals.str.contains(_INT_RE).all():
                return clean.cast(pl.Int64)
            if vals.str.contains(_FLOAT_RE).all():
                return clean.cast(pl.Float64)
        for fmt in _DATE_FORMATS:  # ISO dates only, so day/month are never swapped
            parsed = clean.str.to_date(fmt, strict=False)
            if parsed.null_count() == clean.null_count():
                return parsed
        for fmt in _DATETIME_FORMATS:
            parsed = clean.str.to_datetime(fmt, strict=False)
            if parsed.null_count() == clean.null_count():
                return parsed
    except CATCH:
        pass
    return s


def smart_types(df: pl.DataFrame) -> pl.DataFrame:
    return df.with_columns([_convert_column(df[c]) for c in df.columns])


def resolve_delimiter(name: str, sample: bytes) -> str:
    if name in DELIMS:
        return DELIMS[name]
    try:
        return csv.Sniffer().sniff(sample[:8192].decode("utf-8", errors="ignore"), delimiters=",;\t|").delimiter
    except Exception:
        return ","


def read_head(path: Path, limit: int = 5_000_000) -> bytes:
    with open(path, "rb") as fh:
        chunk = fh.read(limit)
    if len(chunk) == limit:  # drop a possibly cut-off last line
        cut = chunk.rfind(b"\n")
        if cut > 0:
            chunk = chunk[:cut]
    return chunk


def count_data_rows(path: Path) -> int:
    lines, last = 0, b"\n"
    with open(path, "rb") as fh:
        while chunk := fh.read(8 * 1024 * 1024):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    if last != b"\n":
        lines += 1
    return max(lines - 1, 0)  # minus the header; an estimate if fields contain line breaks


def read_csv_path(path: Path, sep: str, infer_types: bool) -> pl.DataFrame:
    df = pl.read_csv(
        path,
        separator=sep,
        infer_schema_length=0,  # every column as text: mixed columns never fail
        encoding="utf8-lossy",
        truncate_ragged_lines=True,
    )
    if infer_types:
        try:
            df = smart_types(df)
        except CATCH:
            pass
    return df


@app.post("/api/csv/upload")
def csv_upload():
    cleanup_old()
    f = request.files.get("file")
    if not f or not f.filename:
        raise ApiError("No file was received.")
    if Path(f.filename).suffix.lower() not in {".csv", ".tsv", ".txt"}:
        raise ApiError("Choose a .csv, .tsv or .txt file.")
    cid = new_id()
    d = DATA_DIR / f"c_{cid}"
    d.mkdir(parents=True)
    path = d / "data.csv"
    f.save(path)
    meta = {"name": f.filename, "size": path.stat().st_size, "rows": count_data_rows(path)}
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return jsonify({"id": cid, **meta})


@app.get("/api/csv/<cid>/preview")
def csv_preview(cid):
    d = entry_dir("c", cid)
    chunk = read_head(d / "data.csv")
    sep = resolve_delimiter(request.args.get("delimiter", "auto"), chunk)
    try:
        df = pl.read_csv(
            io.BytesIO(chunk),
            separator=sep,
            infer_schema_length=0,
            encoding="utf8-lossy",
            truncate_ragged_lines=True,
            n_rows=10,
        )
    except CATCH as e:
        raise ApiError(f"Could not read this file: {e}")
    return jsonify({"delimiter": SYMBOL_TO_NAME.get(sep, "comma"), "columns": df.columns, "rows": to_text_rows(df)})


def make_sheet_name(raw: str, used: set[str]) -> str:
    """Excel sheet names: max 31 characters, none of []:*?/\\, unique ignoring case."""
    name = re.sub(r"[\[\]:*?/\\]+", "_", raw).strip().strip("'") or "Sheet"
    name = name[:31]
    candidate, i = name, 2
    while candidate.lower() in used:
        suffix = f"_{i}"
        candidate = name[: 31 - len(suffix)] + suffix
        i += 1
    used.add(candidate.lower())
    return candidate


def build_workbook(out: Path, entries, delim_name: str, infer_types: bool, on_progress):
    """Stream CSV files into one workbook with xlsxwriter's constant-memory mode.

    One CSV becomes one sheet. A CSV with more rows than Excel allows is split over
    several sheets. Returns (sheet names, notes, total rows).
    """
    used: set[str] = set()
    sheet_names: list[str] = []
    notes: list[str] = []
    total_rows = 0
    options = {
        "constant_memory": True,
        "strings_to_formulas": False,  # text starting with "=" stays text
        "strings_to_urls": False,
        "strings_to_numbers": False,
        "nan_inf_to_errors": True,
    }
    with Workbook(str(out), options) as wb:
        header_fmt = wb.add_format({"bold": True, "bg_color": "#E3EAFB", "border": 1})
        date_fmt = wb.add_format({"num_format": "yyyy-mm-dd"})
        datetime_fmt = wb.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"})

        for fi, (display, path) in enumerate(entries):
            on_progress(fi / len(entries), f"Reading {display}")
            sep = resolve_delimiter(delim_name, read_head(path, 8192))
            df = read_csv_path(path, sep, infer_types)
            n = df.height
            total_rows += n
            columns = df.columns

            head = df.head(200)
            widths, col_fmts = [], []
            for c in columns:
                try:
                    longest = head[c].cast(pl.String).str.len_chars().max() or 0
                except CATCH:
                    longest = 10
                widths.append(min(max(len(str(c)), longest) + 2, 50))
                dtype = df.schema[c]
                col_fmts.append(date_fmt if dtype == pl.Date else datetime_fmt if dtype == pl.Datetime else None)

            base = Path(display).stem
            part = 0

            def new_sheet():
                nonlocal part
                part += 1
                raw = base if part == 1 else f"{base[:24]}_part{part}"
                name = make_sheet_name(raw, used)
                sheet_names.append(name)
                ws = wb.add_worksheet(name)
                ws.write_row(0, 0, [str(c) for c in columns], header_fmt)
                for j, (w, fm) in enumerate(zip(widths, col_fmts)):
                    ws.set_column(j, j, w, fm)
                ws.freeze_panes(1, 0)
                return ws

            ws, r = new_sheet(), 1
            for i, row in enumerate(df.iter_rows()):
                if r >= MAX_XLSX_ROWS:
                    ws, r = new_sheet(), 1
                ws.write_row(r, 0, row)
                r += 1
                if i % 20_000 == 0:
                    on_progress((fi + i / max(n, 1)) / len(entries), f"Writing {display}: {i:,} of {n:,} rows")
            if part > 1:
                notes.append(f"{display} has more rows than one Excel sheet can hold ({MAX_XLSX_ROWS:,}), so it was split over {part} sheets.")
            del df, head
        on_progress(1.0, "Finishing the workbook")
    return sheet_names, notes, total_rows


def _job_update(jid: str, **kw) -> None:
    with JOBS_LOCK:
        if jid in JOBS:
            JOBS[jid].update(kw)


def _run_build(jid: str, entries, delim_name: str, infer_types: bool) -> None:
    out = DATA_DIR / f"job_{jid}.xlsx"
    try:
        sheets, notes, rows = build_workbook(
            out, entries, delim_name, infer_types, lambda frac, text: _job_update(jid, progress=frac, text=text)
        )
        _job_update(jid, status="done", progress=1.0, text="Done", sheets=sheets, notes=notes, rows=rows,
                    size=out.stat().st_size, path=str(out))
    except CATCH as e:
        out.unlink(missing_ok=True)
        _job_update(jid, status="error", error=str(e) or e.__class__.__name__)


@app.post("/api/csv/build")
def csv_build():
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") or []
    if not ids:
        raise ApiError("Add at least one CSV file first.")
    entries = []
    for cid in ids:
        d = entry_dir("c", str(cid))
        entries.append((load_meta(d)["name"], d / "data.csv"))
    delim = str(body.get("delimiter", "auto"))
    jid = new_id()
    with JOBS_LOCK:
        JOBS[jid] = {"status": "running", "progress": 0.0, "text": "Starting", "created": time.time()}
    threading.Thread(target=_run_build, args=(jid, entries, delim, bool(body.get("inferTypes"))), daemon=True).start()
    return jsonify({"job": jid})


@app.get("/api/csv/job/<jid>")
def csv_job(jid):
    with JOBS_LOCK:
        job = JOBS.get(jid) if ID_RE.match(jid) else None
        if job is None:
            abort(404)
        return jsonify({k: v for k, v in job.items() if k not in {"path", "created"}})


@app.get("/api/csv/job/<jid>/download")
def csv_job_download(jid):
    with JOBS_LOCK:
        job = JOBS.get(jid) if ID_RE.match(jid) else None
        path = job.get("path") if job and job["status"] == "done" else None
    if not path or not Path(path).exists():
        abort(404)
    name = safe_name(request.args.get("name") or "converted")
    if not name.lower().endswith(".xlsx"):
        name += ".xlsx"
    return send_file(
        path,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=name,
    )


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        threaded=True,
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
