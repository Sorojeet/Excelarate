(() => {
  'use strict';

  /* ==========================================================================
     Helpers
     ========================================================================== */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n).toLocaleString();
  const BLANK = '(blank)';
  const safeName = s => String(s).replace(/[\\/*?:"<>|]+/g, '_').trim() || 'file';
  const stem = n => String(n).replace(/\.[^.]+$/, '');
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  const humanSize = n => {
    let v = Number(n);
    for (const u of ['B', 'KB', 'MB', 'GB']) {
      if (v < 1024) return u === 'B' ? `${v} B` : `${v.toFixed(1)} ${u}`;
      v /= 1024;
    }
    return `${v.toFixed(1)} TB`;
  };

  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  const ICONS = {
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    prev: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    first: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
    last: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
  };
  const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

  async function api(url, opts = {}) {
    const o = { ...opts };
    if (o.json !== undefined) {
      o.method = o.method || 'POST';
      o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
    let res;
    try { res = await fetch(url, o); }
    catch { throw new Error('Could not reach the server. Check that it is still running.'); }
    let data = null;
    try { data = await res.json(); } catch { /* response was not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `The request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function upload(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `The upload failed (${xhr.status}).`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
      xhr.send(formData);
    });
  }

  function toast(message, type = 'info', ms = 6000) {
    const el = document.createElement('div');
    el.className = `toast glass no-lit ${type}`;
    el.innerHTML = `<span>${esc(message)}</span><button class="icon-x" type="button" aria-label="Dismiss">${icon('x')}</button>`;
    const remove = () => el.remove();
    $('button', el).addEventListener('click', remove);
    $('#toasts').appendChild(el);
    setTimeout(remove, ms);
  }

  function setupDrop(zone, input, onFiles) {
    input.addEventListener('click', e => e.stopPropagation());
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      if (input.files.length) onFiles([...input.files]);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => {
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    });
  }

  function miniTable(headers, rows, numeric = []) {
    const head = headers.map((h, i) => `<th class="plain ${numeric.includes(i) ? 'num' : ''}" scope="col">${esc(h)}</th>`).join('');
    const body = rows.map(r => `<tr>${r.map((v, i) => `<td class="${numeric.includes(i) ? 'num' : ''}${v === null ? ' null' : ''}">${v === null ? '–' : esc(v)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap static"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /* ==========================================================================
     Theme, mode switch, pointer glare
     ========================================================================== */
  const themeBtn = $('#themeBtn');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('gc-theme', t); } catch { /* storage unavailable */ }
    themeBtn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
  }
  themeBtn.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  setTheme(document.documentElement.dataset.theme || 'dark');

  const modeSwitch = $('#modeSwitch');
  function setMode(mode) {
    modeSwitch.dataset.mode = mode;
    $$('button', modeSwitch).forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    $('#view-excel').hidden = mode !== 'excel';
    $('#view-csv').hidden = mode !== 'csv';
    history.replaceState(null, '', '#' + mode);
  }
  modeSwitch.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  setMode(location.hash === '#csv' ? 'csv' : 'excel');

  let glareFrame = 0;
  document.addEventListener('pointermove', e => {
    const g = e.target.closest && e.target.closest('.glass');
    if (!g || g.classList.contains('no-lit') || glareFrame) return;
    glareFrame = requestAnimationFrame(() => {
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', `${e.clientX - r.left}px`);
      g.style.setProperty('--my', `${e.clientY - r.top}px`);
      glareFrame = 0;
    });
  }, { passive: true });

  /* ==========================================================================
     Excel to CSV
     ========================================================================== */
  const X = {
    id: null, meta: null, sheet: 0, cols: [], search: '', filters: [], sort: null,
    page: 1, pageSize: 100, tab: 'preview', result: null, seq: 0, uid: 0,
    exp: { delimiter: 'comma', header: true, bom: false },
  };

  setupDrop($('#xDrop'), $('#xInput'), files => xUpload(files[0]));

  function resetExcel() {
    X.id = null;
    $('#xWork').hidden = true;
    $('#xEmpty').hidden = false;
  }

  function handleErr(e) {
    if (e && e.status === 404) {
      toast('This file is no longer on the server. Upload it again.', 'error');
      resetExcel();
    } else {
      toast((e && e.message) || 'Something went wrong.', 'error');
    }
  }

  async function xUpload(file) {
    if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) return toast('Choose an .xlsx, .xlsm or .xls file.', 'error');
    const zone = $('#xDrop');
    const box = $('.dz-progress', zone), bar = $('.bar', zone), fill = $('.bar span', zone), status = $('.dz-status', zone);
    box.hidden = false; bar.classList.remove('busy'); fill.style.width = '0%'; status.textContent = 'Uploading';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const meta = await upload('/api/excel/upload', fd, p => {
        fill.style.width = `${Math.round(p * 100)}%`;
        if (p >= 1) { bar.classList.add('busy'); status.textContent = 'Reading every sheet'; }
        else status.textContent = `Uploading ${Math.round(p * 100)}%`;
      });
      X.id = meta.id;
      X.meta = meta;
      $('#xFileName').textContent = meta.filename;
      $('#xFileMeta').textContent = `${humanSize(meta.size)}, ${plural(meta.sheets.length, 'sheet', 'sheets')}`;
      $('#xEmpty').hidden = true;
      $('#xWork').hidden = false;
      renderSheets();
      await selectSheet(0);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      box.hidden = true;
      bar.classList.remove('busy');
    }
  }

  $('#xReplace').addEventListener('click', resetExcel);

  /* ---- sheets ---- */
  function renderSheets() {
    $('#xSheets').innerHTML = X.meta.sheets.map((s, i) =>
      `<button type="button" class="chip" data-i="${i}" aria-pressed="${i === X.sheet}">${esc(s.name)} <small>${plural(s.rows, 'row', 'rows')}</small></button>`
    ).join('');
  }
  $('#xSheets').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b && Number(b.dataset.i) !== X.sheet) selectSheet(Number(b.dataset.i));
  });

  async function selectSheet(i) {
    X.sheet = i; X.search = ''; X.filters = []; X.sort = null; X.page = 1; X.result = null;
    $('#xSearch').value = '';
    renderSheets();
    try {
      const d = await api(`/api/excel/${X.id}/sheet/${i}/columns`);
      X.cols = d.columns;
    } catch (e) { return handleErr(e); }
    renderAddFilterOptions();
    renderFilterCards();
    setTab('preview');
    await refresh();
  }

  /* ---- tabs ---- */
  $('#xTabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab);
  });
  function setTab(tab) {
    X.tab = tab;
    $$('#xTabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('#xWork .panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'columns') loadColumns();
    if (tab === 'stats') loadStats();
    if (tab === 'export') renderExport();
  }

  /* ---- filters ---- */
  const KIND_LABEL = { number: 'Number', date: 'Date', values: 'List', text: 'Text' };

  function toSpec(f) {
    const s = f.state;
    if (f.kind === 'number') return s.min === '' && s.max === '' ? null : { col: f.col, kind: 'number', min: s.min, max: s.max };
    if (f.kind === 'date') return !s.start && !s.end ? null : { col: f.col, kind: 'date', start: s.start, end: s.end };
    if (f.kind === 'values') return s.values.size ? { col: f.col, kind: 'values', values: [...s.values] } : null;
    return s.text.trim() === '' ? null : { col: f.col, kind: 'text', mode: s.mode, text: s.text };
  }
  const filterOnly = () => ({ search: X.search, filters: X.filters.map(toSpec).filter(Boolean) });
  const querySpec = () => ({ ...filterOnly(), sort: X.sort, page: X.page, pageSize: X.pageSize });
  const activeCount = () => (X.search.trim() ? 1 : 0) + X.filters.filter(f => toSpec(f)).length;

  function renderAddFilterOptions() {
    const used = new Set(X.filters.map(f => f.ci));
    $('#xAddFilter').innerHTML = '<option value="">Filter a column</option>' +
      X.cols.map((c, i) => `<option value="${i}"${used.has(i) ? ' disabled' : ''}>${esc(c.name)}</option>`).join('');
  }
  $('#xAddFilter').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (v !== '') addFilter(Number(v));
  });

  async function addFilter(ci) {
    const c = X.cols[ci];
    const f = {
      uid: ++X.uid, ci, col: c.name, kind: c.kind, info: null, options: [],
      state: { min: '', max: '', start: '', end: '', values: new Set(), mode: 'contains', text: '' },
    };
    X.filters.push(f);
    renderAddFilterOptions();
    renderFilterCards();
    try {
      const info = await api(`/api/excel/${X.id}/sheet/${X.sheet}/column/${ci}`);
      f.info = info;
      f.kind = info.kind === 'text' && info.values ? 'values' : info.kind;
      f.options = (info.hasBlank ? [BLANK] : []).concat(info.values || []);
    } catch (e) {
      X.filters = X.filters.filter(x => x !== f);
      renderAddFilterOptions();
      handleErr(e);
    }
    renderFilterCards();
  }

  function cardHtml(f) {
    const s = f.state;
    let body = '<p class="muted small">Loading</p>';
    if (f.info) {
      if (f.info.empty) {
        body = '<p class="muted small">This column is empty, so there is nothing to filter.</p>';
      } else if (f.kind === 'number') {
        body = `<div class="pair">
          <label>From<input type="number" step="any" data-k="min" value="${esc(s.min)}" placeholder="${esc(f.info.min)}"></label>
          <label>To<input type="number" step="any" data-k="max" value="${esc(s.max)}" placeholder="${esc(f.info.max)}"></label></div>`;
      } else if (f.kind === 'date') {
        body = `<div class="pair">
          <label>From<input type="date" data-k="start" value="${esc(s.start)}" min="${esc(f.info.min)}" max="${esc(f.info.max)}"></label>
          <label>To<input type="date" data-k="end" value="${esc(s.end)}" min="${esc(f.info.min)}" max="${esc(f.info.max)}"></label></div>`;
      } else if (f.kind === 'values') {
        body = `<div>
          <input type="search" data-k="find" placeholder="Find a value" aria-label="Find a value in ${esc(f.col)}" autocomplete="off">
          <div class="pick-actions"><button type="button" data-act="all">Select shown</button><button type="button" data-act="none">Clear</button><span class="count">${s.values.size} selected</span></div>
          <div class="pick-list">${f.options.map((o, i) =>
            `<label data-vi="${i}"><input type="checkbox" data-vi="${i}"${s.values.has(o) ? ' checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div></div>`;
      } else {
        body = `<div class="mini-field">Match
          <select data-k="mode">${['contains', 'equals', 'starts with', 'ends with'].map(m => `<option${m === s.mode ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
          <label class="mini-field">Text<input type="text" data-k="text" value="${esc(s.text)}" autocomplete="off"></label>`;
      }
    }
    return `<div class="f-card" data-uid="${f.uid}">
      <div class="f-head"><b title="${esc(f.col)}">${esc(f.col)}</b><span class="tag">${KIND_LABEL[f.kind] || 'Text'}</span>
      <button type="button" class="icon-x" data-act="remove" aria-label="Remove the filter on ${esc(f.col)}">${icon('x')}</button></div>${body}</div>`;
  }
  function renderFilterCards() {
    $('#xFGrid').innerHTML = X.filters.map(cardHtml).join('');
    updateClearBtn();
  }
  const updateClearBtn = () => { $('#xClear').hidden = !(X.search.trim() || X.filters.length); };
  const filtersChanged = (() => {
    const go = debounce(() => { X.page = 1; refresh(); }, 280);
    return () => { updateClearBtn(); go(); };
  })();

  const filterById = el => {
    const card = el.closest('.f-card');
    return card ? { card, f: X.filters.find(x => x.uid === Number(card.dataset.uid)) } : {};
  };
  const updatePickCount = (card, f) => { const c = $('.count', card); if (c) c.textContent = `${f.state.values.size} selected`; };

  $('#xFGrid').addEventListener('input', e => {
    const { card, f } = filterById(e.target);
    if (!f) return;
    const t = e.target, k = t.dataset.k;
    if (k === 'find') {
      const q = t.value.toLowerCase();
      $$('.pick-list label', card).forEach(l => { l.hidden = !f.options[Number(l.dataset.vi)].toLowerCase().includes(q); });
      return;
    }
    if (t.type === 'checkbox') {
      const v = f.options[Number(t.dataset.vi)];
      if (t.checked) f.state.values.add(v); else f.state.values.delete(v);
      updatePickCount(card, f);
    } else if (k) {
      f.state[k] = t.value;
    }
    filtersChanged();
  });

  $('#xFGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { card, f } = filterById(btn);
    if (!f) return;
    const act = btn.dataset.act;
    if (act === 'remove') {
      X.filters = X.filters.filter(x => x !== f);
      renderAddFilterOptions();
      renderFilterCards();
      filtersChanged();
    } else if (act === 'all') {
      $$('.pick-list label:not([hidden]) input', card).forEach(i => { i.checked = true; f.state.values.add(f.options[Number(i.dataset.vi)]); });
      updatePickCount(card, f);
      filtersChanged();
    } else if (act === 'none') {
      f.state.values.clear();
      $$('.pick-list input', card).forEach(i => { i.checked = false; });
      updatePickCount(card, f);
      filtersChanged();
    }
  });

  $('#xSearch').addEventListener('input', e => { X.search = e.target.value; filtersChanged(); });
  $('#xClear').addEventListener('click', () => {
    X.search = ''; X.filters = []; X.page = 1;
    $('#xSearch').value = '';
    renderAddFilterOptions();
    renderFilterCards();
    refresh();
  });

  /* ---- table ---- */
  async function refresh() {
    const mine = ++X.seq;
    const wrap = $('#xTable');
    wrap.classList.add('loading');
    try {
      const r = await api(`/api/excel/${X.id}/sheet/${X.sheet}/query`, { json: querySpec() });
      if (mine !== X.seq) return;
      X.result = r;
      renderResultLine();
      renderTable();
      renderPager();
    } catch (e) {
      if (mine === X.seq) handleErr(e);
    } finally {
      if (mine === X.seq) wrap.classList.remove('loading');
    }
  }

  function renderResultLine() {
    const r = X.result, n = activeCount();
    $('#xResult').innerHTML = n
      ? `Showing <b>${fmt(r.filtered)}</b> of ${fmt(r.total)} rows with ${plural(n, 'filter', 'filters')} applied`
      : `<b>${fmt(r.total)}</b> rows and ${plural(X.cols.length, 'column', 'columns')}`;
    updateClearBtn();
  }

  function renderTable() {
    const r = X.result, wrap = $('#xTable');
    if (!X.cols.length) { wrap.innerHTML = '<p class="empty">This sheet has no columns.</p>'; return; }
    if (!r.rows.length) {
      wrap.innerHTML = `<p class="empty">${r.total === 0 ? 'This sheet has no rows.' : 'No rows match the current filters.'}</p>`;
      return;
    }
    const start = (r.page - 1) * r.pageSize;
    const head = X.cols.map((c, i) => {
      const dir = X.sort && X.sort.col === c.name ? (X.sort.desc ? 'descending' : 'ascending') : 'none';
      const arrow = dir === 'ascending' ? icon('up') : dir === 'descending' ? icon('down') : '';
      return `<th scope="col" class="${c.kind === 'number' ? 'num' : ''}" aria-sort="${dir}"><button type="button" class="th-btn" data-i="${i}" title="Sort by ${esc(c.name)}">${esc(c.name)}<span class="sort">${arrow}</span></button></th>`;
    }).join('');
    const body = r.rows.map((row, ri) =>
      `<tr><th class="rn" scope="row">${fmt(start + ri + 1)}</th>${row.map((v, ci) =>
        v === null ? '<td class="null">–</td>' : `<td class="${X.cols[ci].kind === 'number' ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`
    ).join('');
    wrap.innerHTML = `<table class="grid"><thead><tr><th class="rn plain"></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  $('#xTable').addEventListener('click', e => {
    const b = e.target.closest('.th-btn');
    if (!b) return;
    const col = X.cols[Number(b.dataset.i)].name;
    if (!X.sort || X.sort.col !== col) X.sort = { col, desc: false };
    else if (!X.sort.desc) X.sort.desc = true;
    else X.sort = null;
    X.page = 1;
    refresh();
  });

  function renderPager() {
    const r = X.result;
    const pages = Math.max(1, Math.ceil(r.filtered / r.pageSize));
    const from = r.filtered ? (r.page - 1) * r.pageSize + 1 : 0;
    const to = Math.min(r.page * r.pageSize, r.filtered);
    const nav = (act, label, ic, off) => `<button class="btn icon" type="button" data-pg="${act}" aria-label="${label}"${off ? ' disabled' : ''}>${icon(ic)}</button>`;
    $('#xPager').innerHTML = `<span class="info">Rows ${fmt(from)} to ${fmt(to)} of ${fmt(r.filtered)}</span>
      ${nav('first', 'First page', 'first', r.page <= 1)}${nav('prev', 'Previous page', 'prev', r.page <= 1)}
      <span class="page">Page ${fmt(r.page)} of ${fmt(pages)}</span>
      ${nav('next', 'Next page', 'next', r.page >= pages)}${nav('last', 'Last page', 'last', r.page >= pages)}
      <select id="xPageSize" aria-label="Rows per page">${[50, 100, 250, 500, 1000].map(n => `<option value="${n}"${n === r.pageSize ? ' selected' : ''}>${n} rows</option>`).join('')}</select>`;
  }
  $('#xPager').addEventListener('click', e => {
    const b = e.target.closest('[data-pg]');
    if (!b || !X.result) return;
    const pages = Math.max(1, Math.ceil(X.result.filtered / X.result.pageSize));
    const go = { first: 1, prev: X.page - 1, next: X.page + 1, last: pages }[b.dataset.pg];
    X.page = Math.min(Math.max(go, 1), pages);
    refresh();
    $('#xResult').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('#xPager').addEventListener('change', e => {
    if (e.target.id === 'xPageSize') { X.pageSize = Number(e.target.value); X.page = 1; refresh(); }
  });

  /* ---- columns and statistics ---- */
  async function loadColumns() {
    const box = $('#xColsBody');
    box.innerHTML = '<p class="empty">Loading</p>';
    try {
      const d = await api(`/api/excel/${X.id}/sheet/${X.sheet}/profile`, { json: filterOnly() });
      if (X.tab !== 'columns') return;
      const note = activeCount() ? `<p class="result-line">These counts reflect your current filters (${fmt(d.rows)} rows).</p>` : '';
      box.innerHTML = note + (d.columns.length
        ? miniTable(['Column', 'Type', 'Blank cells', 'Distinct values'], d.columns.map(c => [c.name, c.dtype, fmt(c.nulls), c.unique == null ? '' : fmt(c.unique)]), [2, 3])
        : '<p class="empty">This sheet has no columns.</p>');
    } catch (e) { handleErr(e); }
  }

  async function loadStats() {
    const box = $('#xStatsBody');
    box.innerHTML = '<p class="empty">Loading</p>';
    try {
      const d = await api(`/api/excel/${X.id}/sheet/${X.sheet}/stats`, { json: filterOnly() });
      if (X.tab !== 'stats') return;
      const note = activeCount() ? '<p class="result-line">These statistics reflect your current filters.</p>' : '';
      box.innerHTML = note + (d.rows.length ? miniTable(d.columns, d.rows) : '<p class="empty">There are no rows to summarise.</p>');
    } catch (e) { handleErr(e); }
  }

  /* ---- export ---- */
  const xFileName = () => `${safeName(stem(X.meta.filename))}_${safeName(X.meta.sheets[X.sheet].name)}.csv`;

  function renderExport() {
    const r = X.result, e = X.exp, n = activeCount();
    const rows = r ? r.filtered : X.meta.sheets[X.sheet].rows;
    const total = X.meta.sheets[X.sheet].rows;
    $('#xExportBody').innerHTML = `<div class="export-grid">
      <h3>Selected sheet</h3>
      <div><span class="pill">${esc(xFileName())}</span></div>
      <p class="muted">Exporting <b>${fmt(rows)}</b> of ${fmt(total)} rows${n ? ` with ${plural(n, 'filter', 'filters')} applied` : ''}.${rows === 0 ? ' Nothing matches, so the file would contain only the header row.' : ''}</p>
      <div class="opts">
        <label class="field"><span>Delimiter</span>
          <select id="xDelim">${[['comma', 'Comma ( , )'], ['semicolon', 'Semicolon ( ; )'], ['tab', 'Tab'], ['pipe', 'Pipe ( | )']]
            .map(([v, l]) => `<option value="${v}"${v === e.delimiter ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="switch"><input type="checkbox" id="xHeader"${e.header ? ' checked' : ''}><span>Include header row</span></label>
        <label class="switch"><input type="checkbox" id="xBom"${e.bom ? ' checked' : ''}><span>Excel-friendly encoding (UTF-8 BOM)</span></label>
      </div>
      <div class="actions">
        <button class="btn primary" id="xDownload" type="button">${icon('download')} Download CSV</button>
        ${X.meta.sheets.length > 1 ? `<a class="btn" id="xZip" href="#" download>${icon('download')} Download every sheet (ZIP)</a>` : ''}
      </div>
      ${X.meta.sheets.length > 1 ? '<p class="muted small">The ZIP holds every sheet as its own CSV, without filters.</p>' : ''}
    </div>`;
    updateZipLink();
  }
  function updateZipLink() {
    const z = $('#xZip');
    if (z) z.href = `/api/excel/${X.id}/zip?delimiter=${X.exp.delimiter}&header=${X.exp.header ? 1 : 0}&bom=${X.exp.bom ? 1 : 0}`;
  }
  $('#xExportBody').addEventListener('input', e => {
    if (e.target.id === 'xDelim') X.exp.delimiter = e.target.value;
    if (e.target.id === 'xHeader') X.exp.header = e.target.checked;
    if (e.target.id === 'xBom') X.exp.bom = e.target.checked;
    updateZipLink();
  });
  $('#xExportBody').addEventListener('click', async e => {
    const btn = e.target.closest('#xDownload');
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/excel/${X.id}/sheet/${X.sheet}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...querySpec(), ...X.exp }),
      });
      if (!res.ok) {
        let msg = `The export failed (${res.status}).`;
        try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const name = decodeURIComponent(res.headers.get('X-Filename') || xFileName());
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Downloaded ${name}`, 'ok', 3500);
    } catch (err) {
      handleErr(err);
    } finally {
      btn.disabled = false;
    }
  });

  /* ==========================================================================
     CSV to Excel
     ========================================================================== */
  const C = { files: [], delimiter: 'auto', infer: false, job: null, timer: null, result: null, nameTouched: false, uid: 0 };

  setupDrop($('#cDrop'), $('#cInput'), files => cAdd(files));

  async function cAdd(files) {
    const ok = files.filter(f => /\.(csv|tsv|txt)$/i.test(f.name));
    if (ok.length < files.length) toast('Only .csv, .tsv and .txt files can be added.', 'error');
    for (const f of ok) await cUpload(f);
  }

  async function cUpload(file) {
    const item = { key: ++C.uid, name: file.name, size: file.size, id: null, rows: 0, preview: null, progress: 0, status: 'uploading', open: C.files.length < 3, error: '' };
    C.files.push(item);
    clearResult();
    renderFiles();
    try {
      const fd = new FormData();
      fd.append('file', file);
      const meta = await upload('/api/csv/upload', fd, p => {
        item.progress = p;
        const el = $(`[data-key="${item.key}"] .bar span`);
        if (el) el.style.width = `${Math.round(p * 100)}%`;
      });
      Object.assign(item, { id: meta.id, rows: meta.rows, size: meta.size, status: 'loading' });
      renderFiles();
      item.preview = await api(`/api/csv/${item.id}/preview?delimiter=${C.delimiter}`);
      item.status = 'ready';
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
      toast(`${file.name}: ${e.message}`, 'error');
    }
    renderFiles();
  }

  function fileCard(f) {
    const tags = f.status === 'ready'
      ? `<span class="tag">${humanSize(f.size)}</span><span class="tag">${plural(f.rows, 'row', 'rows')}</span><span class="tag">${plural(f.preview.columns.length, 'column', 'columns')}</span>`
      : `<span class="tag">${humanSize(f.size)}</span>`;
    let body;
    if (f.status === 'uploading') body = `<div class="bar"><span style="width:${Math.round(f.progress * 100)}%"></span></div><p class="muted small">Uploading</p>`;
    else if (f.status === 'loading') body = '<p class="muted small">Reading the first rows</p>';
    else if (f.status === 'error') body = `<p class="fc-err">${esc(f.error)}</p>`;
    else {
      const shown = f.preview.rows.length;
      body = !f.preview.columns.length ? '<p class="muted">No columns found in this file.</p>'
        : miniTable(f.preview.columns, f.preview.rows) +
          `<p class="muted small" style="margin-top:8px">${shown ? `Showing the first ${plural(shown, 'row', 'rows')}. The workbook will contain every row.` : 'This file has a header row but no data rows.'}</p>`;
    }
    return `<details class="fcard glass no-lit" data-key="${f.key}"${f.open ? ' open' : ''}>
      <summary><div class="fc-ic">${icon('file')}</div>
        <div class="fc-text"><b>${esc(f.name)}</b>${f.status === 'ready' ? `<span class="muted small">Delimiter: ${esc(f.preview.delimiter)}</span>` : ''}</div>
        <div class="fc-tags">${tags}</div>
        <button type="button" class="icon-x" data-remove="${f.key}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></summary>
      <div class="fc-body">${body}</div></details>`;
  }

  function renderFiles() {
    const has = C.files.length > 0;
    $('#cFiles').innerHTML = C.files.map(fileCard).join('');
    $('#cWork').hidden = !has;
    $('#cSteps').hidden = has;
    $('#cDrop').classList.toggle('compact', has);
    $('#cDropTitle').textContent = has ? 'Add more CSV files' : 'Drop one or more CSV files here';
    renderExportInfo();
  }

  $('#cFiles').addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    e.preventDefault();
    C.files = C.files.filter(f => String(f.key) !== rm.dataset.remove);
    clearResult();
    renderFiles();
  });
  $('#cFiles').addEventListener('toggle', e => {
    const d = e.target;
    if (d.matches && d.matches('details.fcard')) {
      const f = C.files.find(x => String(x.key) === d.dataset.key);
      if (f) f.open = d.open;
    }
  }, true);

  const readyFiles = () => C.files.filter(f => f.status === 'ready');

  function renderExportInfo() {
    const ready = readyFiles();
    const busy = C.files.some(f => f.status === 'uploading' || f.status === 'loading');
    const rows = ready.reduce((n, f) => n + f.rows, 0);
    $('#cExportInfo').textContent = ready.length
      ? `${plural(ready.length, 'file', 'files')} will become ${plural(ready.length, 'sheet', 'sheets')}, with about ${fmt(rows)} rows in total.`
      : 'Add a CSV file to begin.';
    $('#cBuild').disabled = !ready.length || busy || !!C.timer;
    if (!C.nameTouched) $('#cName').value = ready.length === 1 ? stem(ready[0].name) : 'combined';
  }

  $('#cDelim').addEventListener('change', async e => {
    C.delimiter = e.target.value;
    clearResult();
    await Promise.all(readyFiles().map(async f => {
      try { f.preview = await api(`/api/csv/${f.id}/preview?delimiter=${C.delimiter}`); }
      catch (err) { f.status = 'error'; f.error = err.message; }
    }));
    renderFiles();
  });
  $('#cInfer').addEventListener('change', e => { C.infer = e.target.checked; clearResult(); });

  const dlName = () => `${safeName($('#cName').value.trim() || 'converted').replace(/\.xlsx$/i, '')}.xlsx`;
  const dlUrl = () => `/api/csv/job/${C.result.job}/download?name=${encodeURIComponent(dlName())}`;
  $('#cName').addEventListener('input', () => {
    C.nameTouched = true;
    if (C.result) {
      $('#cPill').textContent = dlName();
      $('#cDownload').href = dlUrl();
    }
  });

  function clearResult() {
    clearTimeout(C.timer);
    C.timer = null; C.job = null; C.result = null;
    $('#cProgress').hidden = true;
    renderResult();
    if ($('#cBuild')) $('#cBuild').disabled = !readyFiles().length;
  }

  function renderResult() {
    const box = $('#cResult'), r = C.result;
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<div class="result-top">
        <span class="pill" id="cPill">${esc(dlName())}</span>
        <a class="btn primary" id="cDownload" href="${dlUrl()}" download>${icon('download')} Download Excel</a>
      </div>
      <div class="metrics">
        <div class="metric"><b>${fmt(r.rows)}</b><span>rows written</span></div>
        <div class="metric"><b>${fmt(r.sheets.length)}</b><span>${r.sheets.length === 1 ? 'sheet' : 'sheets'}</span></div>
        <div class="metric"><b>${humanSize(r.size)}</b><span>file size</span></div>
      </div>
      ${r.notes.map(n => `<div class="note">${esc(n)}</div>`).join('')}`;
  }

  $('#cBuild').addEventListener('click', async () => {
    const ready = readyFiles();
    if (!ready.length) return toast('Add at least one CSV file first.', 'error');
    clearResult();
    const wrap = $('#cProgress'), bar = $('.bar', wrap), fill = $('.bar span', wrap), text = $('#cProgressText');
    wrap.hidden = false; bar.classList.add('busy'); fill.style.width = '2%'; text.textContent = 'Starting';
    $('#cBuild').disabled = true;
    try {
      const { job } = await api('/api/csv/build', { json: { ids: ready.map(f => f.id), delimiter: C.delimiter, inferTypes: C.infer } });
      C.job = job;
      const tick = async () => {
        if (C.job !== job) return;
        try {
          const s = await api(`/api/csv/job/${job}`);
          if (C.job !== job) return;
          fill.style.width = `${Math.max(2, Math.round(s.progress * 100))}%`;
          text.textContent = s.text || 'Working';
          if (s.status === 'running') { C.timer = setTimeout(tick, 700); return; }
          C.timer = null;
          bar.classList.remove('busy');
          if (s.status === 'done') {
            wrap.hidden = true;
            C.result = { ...s, job };
            renderResult();
          } else {
            wrap.hidden = true;
            $('#cResult').hidden = false;
            $('#cResult').innerHTML = `<div class="note bad">${esc(s.error || 'The workbook could not be built.')}</div>`;
          }
          $('#cBuild').disabled = false;
        } catch (e) {
          C.timer = null;
          bar.classList.remove('busy');
          wrap.hidden = true;
          $('#cBuild').disabled = false;
          toast(e.message, 'error');
        }
      };
      tick();
    } catch (e) {
      bar.classList.remove('busy');
      wrap.hidden = true;
      $('#cBuild').disabled = false;
      toast(e.message, 'error');
    }
  });
})();
