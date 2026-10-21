# Builds a Tauri updater manifest (UTF-8, no BOM) with the approved bilingual notes.
# usage: manifest.py <sig_file> <url> <out_json>
import json, sys, datetime, pathlib

sig_file, url, out = sys.argv[1:4]
here = pathlib.Path(__file__).parent
notes = (here / "notes.txt").read_text(encoding="utf-8").strip()
sig = pathlib.Path(sig_file).read_text(encoding="utf-8").strip()
m = {
    "version": "1.0.37",
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"windows-x86_64": {"signature": sig, "url": url}},
}
pathlib.Path(out).write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(m, ensure_ascii=False, indent=2))
