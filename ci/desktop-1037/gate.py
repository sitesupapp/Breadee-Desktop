# Evaluates the update-in-place evidence and FAILS the run on any preservation/identity deviation.
# usage: gate.py <dir with seed.json update.json post.json facts.json>
import json, sys, pathlib

d = pathlib.Path(sys.argv[1])
load = lambda n: json.loads((d / n).read_text(encoding="utf-8"))
seed, upd, post, facts = load("seed.json"), load("update.json"), load("post.json"), load("facts.json")
notes = (pathlib.Path(__file__).parent / "notes.txt").read_text(encoding="utf-8").strip()

checks = []
def check(name, ok, detail=""):
    checks.append({"check": name, "ok": bool(ok), "detail": detail})

check("pre: installed production app is 1.0.36", seed.get("version") == "1.0.36" or str(facts.get("pre_fileversion", "")).startswith("1.0.36"), f"{seed.get('version')} / file {facts.get('pre_fileversion')}")
c = upd.get("check") or {}
check("updater check: 1.0.37 offered by the channel", c.get("available") and c.get("version") == "1.0.37", c.get("version"))
check("updater check: current version 1.0.36", c.get("currentVersion") == "1.0.36", c.get("currentVersion"))
check("pre-update notes = approved bilingual text (readable before Update)", (c.get("body") or "").strip() == notes, (c.get("body") or "")[:80])
check("no updater error (signature verified by the installed app's baked key)", not any(p.get("error") for p in upd.get("progress", [])), json.dumps(upd.get("progress", [])[-2:], ensure_ascii=False))
check("installed exe file version is 1.0.37 after update", str(facts.get("post_fileversion", "")).startswith("1.0.37"), facts.get("post_fileversion"))
check("updated IN PLACE (same install path)", facts.get("pre_exe") == facts.get("post_exe"), f"{facts.get('pre_exe')} -> {facts.get('post_exe')}")
check("post: running app reports 1.0.37 (or exe file version when the IPC read is not permitted)", post.get("version") == "1.0.37" or (str(post.get("version", "")).startswith("unreadable") and str(facts.get("post_fileversion", "")).startswith("1.0.37")), post.get("version"))
check("localStorage marker preserved", seed.get("planted") and post.get("lsMarker") == seed.get("planted"), f"{seed.get('planted')} / {post.get('lsMarker')}")
missing = sorted(set(seed.get("localStorageKeys", {})) - set(post.get("localStorageKeys", {})))
check("every pre-update localStorage key still present (device identity / context / printer config)", not missing, ",".join(missing))
check("IndexedDB marker preserved", (post.get("idbMarker") or {}).get("marker") == seed.get("planted"), json.dumps(post.get("idbMarker")))
for name, pre in (seed.get("idb") or {}).items():
    if name == "qa-1037-marker":
        continue
    po = (post.get("idb") or {}).get(name)
    ok = po is not None and "error" not in po and po.get("version", 0) >= pre.get("version", 0)
    lost = [s for s, n in (pre.get("stores") or {}).items() if (po or {}).get("stores", {}).get(s, -1) < n]
    check(f"IndexedDB '{name}' kept (version {pre.get('version')}->{(po or {}).get('version')}), no store lost/shrunk", ok and not lost, ",".join(lost))
check("data-folder marker file preserved byte-for-byte", facts.get("marker_pre") and facts.get("marker_pre") == facts.get("marker_post"), "")
check("data folder still present", facts.get("datadir_exists_post") is True, facts.get("datadir"))
check("channel served latest.json and the installer", facts.get("served_manifest") and facts.get("served_installer"), "")

ok = all(x["ok"] for x in checks)
report = {"verdict": "PASS" if ok else "FAIL", "checks": checks}
(d / "gate.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
for x in checks:
    print(("PASS " if x["ok"] else "FAIL ") + x["check"] + (f"  [{x['detail']}]" if x["detail"] else ""))
print("UPDATE-IN-PLACE:", report["verdict"])
sys.exit(0 if ok else 1)
