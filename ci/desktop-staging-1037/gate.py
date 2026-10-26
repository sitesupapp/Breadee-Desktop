# Evaluates the Breadee Staging 1.0.35 -> 1.0.37 update-in-place evidence and FAILS the run on any
# identity / version / preservation deviation.
# usage: gate.py <dir with seed.json update.json post.json recheck.json facts.json> <artifact notes.txt>
import json, sys, pathlib

d = pathlib.Path(sys.argv[1])
artifact_notes = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip()
load = lambda n: json.loads((d / n).read_text(encoding="utf-8"))
seed, upd, post, recheck, facts = load("seed.json"), load("update.json"), load("post.json"), load("recheck.json"), load("facts.json")
approved = (pathlib.Path(__file__).parent / "notes.txt").read_text(encoding="utf-8").strip()
FROM, TO, IDENT = "1.0.35", "1.0.37", "app.breadee.desktop.staging"

checks = []
def check(name, ok, detail=""):
    checks.append({"check": name, "ok": bool(ok), "detail": detail})

check("pre: installed app is Breadee Staging " + FROM, seed.get("version") == FROM or str(facts.get("pre_fileversion", "")).startswith(FROM), f"{seed.get('version')} / file {facts.get('pre_fileversion')}")
check("pre: identity is " + IDENT + " (or unreadable on " + FROM + ")", seed.get("identifier") == IDENT or str(seed.get("identifier", "")).startswith("unreadable"), seed.get("identifier"))
check("pre: install dir is the Breadee Staging dir (not production Breadee)", "Breadee Staging" in str(facts.get("pre_exe", "")), facts.get("pre_exe"))
check("release notes in the artifact = the approved 1.0.37 bilingual text", artifact_notes == approved, artifact_notes[:80])
c = upd.get("check") or {}
check(f"updater check (staging channel): {TO} offered", c.get("available") and c.get("version") == TO, c.get("version"))
check(f"updater check: current version {FROM}", c.get("currentVersion") == FROM, c.get("currentVersion"))
check("pre-update notes = approved bilingual text", (c.get("body") or "").strip() == approved, (c.get("body") or "")[:80])
check("no updater error (signature verified by the installed app's baked STAGING key)", not any(p.get("error") for p in upd.get("progress", [])), json.dumps(upd.get("progress", [])[-2:], ensure_ascii=False))
check(f"installed exe file version is {TO} after update", str(facts.get("post_fileversion", "")).startswith(TO), facts.get("post_fileversion"))
check("updated IN PLACE (same install path, same exe name)", facts.get("pre_exe") == facts.get("post_exe"), f"{facts.get('pre_exe')} -> {facts.get('post_exe')}")
check("exactly one Breadee Staging exe installed (no second app)", facts.get("staging_exe_count") == 1, facts.get("staging_exe_count"))
check("production Breadee was never installed by the hop", facts.get("prod_install_present") is False, facts.get("prod_install_present"))
check(f"post: running app reports {TO}", post.get("version") == TO or (str(post.get("version", "")).startswith("unreadable") and str(facts.get("post_fileversion", "")).startswith(TO)), post.get("version"))
check("post: identity is still " + IDENT, post.get("identifier") == IDENT, post.get("identifier"))
check("localStorage marker preserved", seed.get("planted") and post.get("lsMarker") == seed.get("planted"), f"{seed.get('planted')} / {post.get('lsMarker')}")
missing = sorted(set(seed.get("localStorageKeys", {})) - set(post.get("localStorageKeys", {})))
check("every pre-update localStorage key still present", not missing, ",".join(missing))
check("IndexedDB marker preserved", (post.get("idbMarker") or {}).get("marker") == seed.get("planted"), json.dumps(post.get("idbMarker")))
for name, pre in (seed.get("idb") or {}).items():
    if name == "qa-staging-marker":
        continue
    po = (post.get("idb") or {}).get(name)
    ok = po is not None and "error" not in po and po.get("version", 0) >= pre.get("version", 0)
    lost = [s for s, n in (pre.get("stores") or {}).items() if (po or {}).get("stores", {}).get(s, -1) < n]
    check(f"IndexedDB '{name}' kept (version {pre.get('version')}->{(po or {}).get('version')}), no store lost/shrunk", ok and not lost, ",".join(lost))
check("data-folder marker file preserved byte-for-byte", facts.get("marker_pre") and facts.get("marker_pre") == facts.get("marker_post"), "")
check("staging data folder still present", facts.get("datadir_exists_post") is True, facts.get("datadir"))
if facts.get("live"):
    # LIVE post-publish mode: the REAL staging channel + the REAL GitHub Release asset.
    check("LIVE: real staging channel advertises " + TO + " with the release URL", facts.get("live_channel_version") == TO and "/releases/download/desktop-staging-v" + TO + "/" in str(facts.get("live_channel_url", "")), f"{facts.get('live_channel_version')} {facts.get('live_channel_url')}")
    check("LIVE: published release asset SHA256 = the release's SHA256SUMS", facts.get("asset_sha256_ok") is True, facts.get("asset_sha256"))
    check("LIVE: installed exe SHA256 changed from 1.0.35 (the hop really replaced the binary)", facts.get("pre_exe_sha256") and facts.get("pre_exe_sha256") != facts.get("post_exe_sha256"), "")
else:
    check("channel served the STAGING latest.json and the installer", facts.get("served_manifest") and facts.get("served_installer"), "")
    check("production channel never requested", facts.get("prod_channel_requested") is False, "")
check(f"post-update recheck reaches the staging channel and offers nothing newer than {TO}", recheck.get("reached") is True and recheck.get("available") is False, json.dumps(recheck))

ok = all(x["ok"] for x in checks)
report = {"verdict": "PASS" if ok else "FAIL", "checks": checks}
(d / "gate.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
for x in checks:
    print(("PASS " if x["ok"] else "FAIL ") + x["check"] + (f"  [{x['detail']}]" if x["detail"] else ""))
print("UPDATE-IN-PLACE:", report["verdict"])
sys.exit(0 if ok else 1)
