# Drives the INSTALLED Breadee Staging app's WebView2 over CDP (remote-debugging port 9222):
#   seed    - record version/identifier + plant localStorage / IndexedDB markers + snapshot every IndexedDB
#   update  - run the app's OWN Tauri updater plugin (check -> download_and_install), the exact calls
#             lib/updater.ts makes behind "Update & Restart". (Staging 1.0.35's JS gate hides that
#             button - the plugin, its compiled staging endpoint/key and the NSIS hop are what is proven.)
#   post    - re-read version/identifier + markers + IndexedDB snapshot after the in-place update
#   recheck - after the update, ask the (now 1.0.37) app's updater again: it must reach the staging
#             channel and report nothing newer (no loop, no downgrade)
# usage: cdp.py <mode> <out_json>
import json, sys, time, urllib.request
import websocket

mode, out = sys.argv[1], sys.argv[2]


def target(wait_s=180):
    deadline = time.time() + wait_s
    while time.time() < deadline:
        try:
            ts = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=3))
            pages = [t for t in ts if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(2)
    raise SystemExit("CDP_UNAVAILABLE")


_id = [0]


def ev(ws, expr, timeout=120):
    _id[0] += 1
    ws.settimeout(timeout)
    ws.send(json.dumps({"id": _id[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            r = m.get("result", {})
            if "exceptionDetails" in r:
                raise RuntimeError(json.dumps(r["exceptionDetails"])[:2000])
            return r["result"].get("value")


SNAPSHOT_JS = r"""
async function __qaSnap(){
  const I = window.__TAURI_INTERNALS__;
  let version = null, identifier = null;
  try { version = await I.invoke('plugin:app|version'); } catch (e) { version = 'unreadable: ' + String(e).slice(0, 80); }
  try { identifier = await I.invoke('plugin:app|identifier'); } catch (e) { identifier = 'unreadable: ' + String(e).slice(0, 80); }
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = (localStorage.getItem(k) || '').length; }
  const dbs = await indexedDB.databases();
  const idb = {};
  for (const d of dbs) {
    idb[d.name] = await new Promise((res) => {
      const r = indexedDB.open(d.name);
      r.onsuccess = async () => {
        const db = r.result; const o = { version: db.version, stores: {} };
        for (const s of Array.from(db.objectStoreNames)) {
          o.stores[s] = await new Promise((rr) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => rr(q.result); q.onerror = () => rr(-1); });
        }
        db.close(); res(o);
      };
      r.onerror = () => res({ error: String(r.error) });
    });
  }
  const qa = await new Promise((res) => {
    const r = indexedDB.open('qa-staging-marker', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => { const db = r.result; const q = db.transaction('m').objectStore('m').get('k'); q.onsuccess = () => { db.close(); res(q.result || null); }; q.onerror = () => { db.close(); res(null); }; };
    r.onerror = () => res(null);
  });
  const hosts = Array.from(new Set(performance.getEntriesByType('resource').map((e) => { try { return new URL(e.name).host; } catch (x) { return ''; } }).filter(Boolean)));
  return { version, identifier, href: location.href, hosts, localStorageKeys: ls, lsMarker: localStorage.getItem('qa_staging_marker'), idbMarker: qa, idb };
}
"""

SEED_JS = SNAPSHOT_JS + r"""
(async () => {
  const marker = 'qastaging-' + Date.now();
  localStorage.setItem('qa_staging_marker', marker);
  await new Promise((res, rej) => {
    const r = indexedDB.open('qa-staging-marker', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').put({ marker, at: new Date().toISOString() }, 'k'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  });
  return Object.assign(await __qaSnap(), { planted: marker });
})()
"""

UPDATE_JS = r"""
(async () => {
  const I = window.__TAURI_INTERNALS__;
  const m = await I.invoke('plugin:updater|check', {});
  if (!m) return { available: false };
  const info = { available: true, currentVersion: m.currentVersion, version: m.version, date: m.date, body: m.body };
  window.__qaStg = { info, events: [] };
  const id = I.transformCallback((msg) => { try { window.__qaStg.events.push((msg && msg.message && msg.message.event) || JSON.stringify(msg).slice(0, 120)); } catch (e) {} });
  I.invoke('plugin:updater|download_and_install', { onEvent: { toJSON() { return '__CHANNEL__:' + id; } }, rid: m.rid })
    .then(() => { window.__qaStg.done = true; }, (e) => { window.__qaStg.error = String(e); });
  return info;
})()
"""

RECHECK_JS = r"""
(async () => {
  const I = window.__TAURI_INTERNALS__;
  try {
    const m = await I.invoke('plugin:updater|check', {});
    return m ? { reached: true, available: true, version: m.version, currentVersion: m.currentVersion } : { reached: true, available: false };
  } catch (e) { return { reached: false, error: String(e).slice(0, 300) }; }
})()
"""

ws = websocket.create_connection(target(), timeout=30, suppress_origin=True)
result = {"mode": mode}
try:
    if mode == "seed":
        result.update(ev(ws, SEED_JS))
    elif mode == "post":
        result.update(ev(ws, SNAPSHOT_JS + "\n__qaSnap()"))
    elif mode == "recheck":
        result.update(ev(ws, RECHECK_JS))
    elif mode == "update":
        result["check"] = ev(ws, UPDATE_JS)
        progress = []
        t0 = time.time()
        while time.time() - t0 < 300:
            time.sleep(2)
            try:
                s = ev(ws, "JSON.stringify(window.__qaStg || null)", timeout=10)
            except Exception as e:  # the app exits when the NSIS installer starts (Tauri on Windows)
                progress.append({"t": round(time.time() - t0, 1), "connection": f"closed ({type(e).__name__})"})
                break
            st = json.loads(s) if s else None
            progress.append({"t": round(time.time() - t0, 1), "events": (st or {}).get("events", [])[-3:], "error": (st or {}).get("error"), "done": (st or {}).get("done")})
            if st and st.get("error"):
                break
        result["progress"] = progress
finally:
    try:
        ws.close()
    except Exception:
        pass

with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2)[:6000])
