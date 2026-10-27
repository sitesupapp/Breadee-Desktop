# Evaluates the LIVE Breadee Staging 1.0.38 -> 1.0.39 in-app update evidence + the native offline-first
# checks, and FAILS the run on any identity / version / preservation / offline-first deviation.
# usage: gate.py <dir with seed post post2 recheck update facts vault offline .json> <live notes.txt>
import json, sys, pathlib

d = pathlib.Path(sys.argv[1])
live_notes = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip()
load = lambda n: json.loads((d / n).read_text(encoding="utf-8"))
seed, upd, post, post2, recheck, facts, vault, offline = (load(n) for n in ("seed.json", "update.json", "post.json", "post2.json", "recheck.json", "facts.json", "vault.json", "offline.json"))
FROM, TO, IDENT = "1.0.38", "1.0.39", "app.breadee.desktop.staging"
DEXIE_V12 = 120  # Dexie verno 12 = IndexedDB version 120 (unchanged by 1.0.39)
FIRST_SIGNIN = "FIRST SECURE SIGN-IN REQUIRES AN INTERNET CONNECTION"

checks = []
def check(name, ok, detail=""):
    checks.append({"check": name, "ok": bool(ok), "detail": str(detail)[:300]})

check("pre: installed app is Breadee Staging " + FROM, seed.get("version") == FROM or str(facts.get("pre_fileversion", "")).startswith(FROM), f"{seed.get('version')} / file {facts.get('pre_fileversion')}")
check("pre: identity is " + IDENT, seed.get("identifier") == IDENT, seed.get("identifier"))
check("pre: install dir is the Breadee Staging dir (not production Breadee)", "Breadee Staging" in str(facts.get("pre_exe", "")), facts.get("pre_exe"))
check("pre: breadee-desktop Dexie at v12 at seed", seed.get("breadeeDbVersionAtSeed") == DEXIE_V12, seed.get("breadeeDbVersionAtSeed"))
pre_ops = seed.get("ops") or {}
ids = seed.get("opIds") or []
check("pre: planted pending + needs_attention operations present", len(ids) == 2 and (pre_ops.get(ids[0]) or {}).get("status") == "pending" and (pre_ops.get(ids[1]) or {}).get("status") == "needs_attention", json.dumps(pre_ops))
c = upd.get("check") or {}
check(f"updater check (LIVE staging channel): {TO} offered", c.get("available") and c.get("version") == TO, c.get("version"))
check(f"updater check: current version {FROM}", c.get("currentVersion") == FROM, c.get("currentVersion"))
check("offered notes = the live channel's bilingual notes", (c.get("body") or "").strip() == live_notes and len(live_notes) > 40, (c.get("body") or "")[:80])
check("no updater error (signature verified by the installed app's baked STAGING key)", not any(p.get("error") for p in upd.get("progress", [])), json.dumps(upd.get("progress", [])[-2:], ensure_ascii=False))
check(f"installed exe file version is {TO} after update", str(facts.get("post_fileversion", "")).startswith(TO), facts.get("post_fileversion"))
check("updated IN PLACE (same install path, same exe name)", facts.get("pre_exe") == facts.get("post_exe"), f"{facts.get('pre_exe')} -> {facts.get('post_exe')}")
check("exactly one Breadee Staging exe installed (no second app)", facts.get("staging_exe_count") == 1, facts.get("staging_exe_count"))
check("production Breadee was never installed by the hop", facts.get("prod_install_present") is False, facts.get("prod_install_present"))
check("LIVE: staging channel advertises " + TO + " with the release URL", facts.get("live_channel_version") == TO and "/releases/download/desktop-staging-v" + TO + "/" in str(facts.get("live_channel_url", "")), f"{facts.get('live_channel_version')} {facts.get('live_channel_url')}")
check("LIVE: published asset SHA256 = SHA256SUMS and .sig = channel signature", facts.get("asset_sha256_ok") is True, facts.get("asset_sha256"))
check("LIVE: installed exe SHA256 changed (the hop really replaced the binary)", facts.get("pre_exe_sha256") and facts.get("pre_exe_sha256") != facts.get("post_exe_sha256"), "")
check("data-folder marker file preserved byte-for-byte", facts.get("marker_pre") and facts.get("marker_pre") == facts.get("marker_post"), "")
check("staging data folder still present", facts.get("datadir_exists_post") is True, facts.get("datadir"))

for label, p in (("relaunch", post), ("second launch", post2)):
    check(f"{label}: running app reports {TO}", p.get("version") == TO, p.get("version"))
    check(f"{label}: getIdentifier allowed (CSP + capabilities) and = {IDENT}", p.get("identifier") == IDENT, p.get("identifier"))
    check(f"{label}: localStorage marker preserved", seed.get("planted") and p.get("lsMarker") == seed.get("planted"), f"{seed.get('planted')} / {p.get('lsMarker')}")
    missing = sorted(set(seed.get("localStorageKeys", {})) - set(p.get("localStorageKeys", {})))
    check(f"{label}: every pre-update localStorage key still present", not missing, ",".join(missing))
    check(f"{label}: device identity preserved exactly", seed.get("deviceIdentity") and p.get("deviceIdentity") == seed.get("deviceIdentity"), "")
    check(f"{label}: printer configuration preserved exactly", seed.get("printerConfig") and p.get("printerConfig") == seed.get("printerConfig"), "")
    check(f"{label}: IndexedDB marker preserved", (p.get("idbMarker") or {}).get("marker") == seed.get("planted"), json.dumps(p.get("idbMarker")))
    bd = (p.get("idb") or {}).get("breadee-desktop") or {}
    check(f"{label}: breadee-desktop Dexie still verno 12 (IDB {DEXIE_V12})", bd.get("version") == DEXIE_V12, bd.get("version"))
    po = p.get("ops") or {}
    for oid in ids:
        pre, now = pre_ops.get(oid) or {}, po.get(oid) or {}
        check(f"{label}: planted op {oid.split('-')[1]} preserved with status '{pre.get('status')}'", now.get("status") == pre.get("status") and now.get("client_op_id") == pre.get("client_op_id"), json.dumps(now))
    for name, pre in (seed.get("idb") or {}).items():
        if name == "qa-staging-marker":
            continue
        cur = (p.get("idb") or {}).get(name)
        ok = cur is not None and "error" not in cur and cur.get("version", 0) >= pre.get("version", 0)
        lost = [s for s, n in (pre.get("stores") or {}).items() if (cur or {}).get("stores", {}).get(s, -1) < n]
        check(f"{label}: IndexedDB '{name}' kept (version {pre.get('version')}->{(cur or {}).get('version')}), no store lost/shrunk", ok and not lost, ",".join(lost))
check(f"post-update recheck reaches the staging channel and offers nothing newer than {TO}", recheck.get("reached") is True and recheck.get("available") is False, json.dumps(recheck))

# --- native offline-first checks (1.0.39) ---
check("NATIVE vault: `offline-vault` seals + unseals through DPAPI (round-trip exact)", vault.get("sealOk") is True and vault.get("roundtrip") is True, json.dumps(vault))
check("NATIVE vault: the probe left the device exactly as found", vault.get("restored") is True, json.dumps(vault))
check("NATIVE vault: an unlisted seal name is still refused (closed allowlist)", str(vault.get("unlisted", "")).startswith("refused"), vault.get("unlisted"))
check("NATIVE offline: WebView reports offline under the network cut", offline.get("navigatorOnLine") is False, offline.get("navigatorOnLine"))
check("NATIVE offline: cold start reaches the sign-in screen with the network cut", isinstance(offline.get("cold_start_to_signin_ms"), int), offline.get("cold_start_to_signin_ms"))
check("NATIVE offline: never-provisioned user gets the FIRST SECURE SIGN-IN message", FIRST_SIGNIN in str(offline.get("text") or ""), offline.get("text"))
check("NATIVE offline: answered without waiting on the network (< 1500 ms)", isinstance(offline.get("ms"), int) and offline["ms"] < 1500, offline.get("ms"))
check("NATIVE offline: ZERO fetch attempts on the offline sign-in path", offline.get("fetchCalls") == 0, offline.get("fetchCalls"))
check("NATIVE offline: no raw transport text shown", "fetch" not in str(offline.get("text") or "").lower(), offline.get("text"))

ok = all(x["ok"] for x in checks)
report = {"verdict": "PASS" if ok else "FAIL", "checks": checks, "native_timings": offline.get("timings"), "native_offline_signin_ms": offline.get("ms"), "native_cold_start_to_signin_ms": offline.get("cold_start_to_signin_ms")}
(d / "gate.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
for x in checks:
    print(("PASS " if x["ok"] else "FAIL ") + x["check"] + (f"  [{x['detail']}]" if x["detail"] else ""))
print("native timings:", json.dumps(offline.get("timings")))
print(f"UPDATE-IN-PLACE {FROM}->{TO} + NATIVE OFFLINE-FIRST:", report["verdict"], f"({sum(x['ok'] for x in checks)}/{len(checks)})")
sys.exit(0 if ok else 1)
