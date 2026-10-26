# Builds the QA staging-channel manifest from the build-only artifact's own
# latest.preview.json (version, signature and bilingual notes exactly as the tag
# would publish them), with ONLY the download URL pointed at the local channel.
# usage: manifest.py <artifact_dir> <url> <out_json>
import json, sys, pathlib

art, url, out = sys.argv[1:4]
art = pathlib.Path(art)
m = json.loads((art / "latest.preview.json").read_text(encoding="utf-8"))
sig = next(art.glob("*.exe.sig")).read_text(encoding="utf-8").strip()
if m["platforms"]["windows-x86_64"]["signature"].strip() != sig:
    raise SystemExit("preview manifest signature != .sig")
m["platforms"]["windows-x86_64"]["url"] = url
pathlib.Path(out).write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(m, ensure_ascii=False, indent=2))
