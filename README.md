# Glassconvert

Excel to CSV and CSV to Excel converter. Flask and Polars on the server, plain HTML, CSS and JavaScript in the browser.

## Run it

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000

## Options (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 5000 | Port to listen on |
| `HOST` | 127.0.0.1 | Use 0.0.0.0 to allow other devices on your network |
| `GLASS_MAX_UPLOAD_MB` | 500 | Largest file accepted |
| `GLASS_TTL_HOURS` | 2 | Uploaded files are deleted after this many idle hours |
| `GLASS_DATA_DIR` | system temp folder | Where uploads and results are kept |

## Deploying

Run it with one worker and several threads, because background builds are tracked in memory:

```bash
gunicorn app:app --workers 1 --threads 8 --timeout 600
```

The included `Procfile` does the same for hosts such as Render or Railway.
