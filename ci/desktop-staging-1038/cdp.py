# Drives the INSTALLED Breadee Staging app's WebView2 over CDP (remote-debugging port 9222) for the
# Staging 1.0.37 -> 1.0.38 LIVE in-app update proof:
#   seed    - record version/identifier + device identity; plant localStorage / printer-config /
#             IndexedDB markers, and TWO operations in the app's own Dexie operations log
#             (one 'pending', one 'needs_attention'); snapshot every IndexedDB
#   update  - run the app's OWN Tauri updater plugin (check -> download_and_install), the exact calls
#             lib/updater.ts makes behind "Update & Restart"
#   post    - re-read version/identifier + every marker + both planted operations + IndexedDB snapshot
#   recheck - ask the (now 1.0.38) app's updater again: it must reach the staging channel and report
#             nothing newer (no loop, no downgrade)
# usage: cdp.py <mode> <out_json> [seed_json (post mode: to look up the planted operation ids)]
import json, sys, time, urllib.request
import websocket

mode, out = sys.argv[1], sys.argv[2]
seed_path = sys.argv[3] if len(sys.argv) > 3 else None


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
async function __qaSnap(opIds){
  const I = window.__TAURI_INTERNALS__;
  let version = null, identifier = null;
  try { version = await I.invoke('plugin:app|version'); } catch (e) { version = 'unreadable: ' + String(e).slice(0, 120); }
  try { identifier = await I.invoke('plugin:app|identifier'); } catch (e) { identifier = 'unreadable: ' + String(e).slice(0, 120); }
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
  const ops = {};
  if (opIds && opIds.length && dbs.some((d) => d.name === 'breadee-desktop')) {
    await new Promise((res) => {
      const r = indexedDB.open('breadee-desktop');
      r.onsuccess = () => {
        const db = r.result;
        if (!Array.from(db.objectStoreNames).includes('operations')) { db.close(); return res(); }
        const st = db.transaction('operations').objectStore('operations');
        let left = opIds.length;
        for (const id of opIds) {
          const q = st.get(id);
          q.onsuccess = () => { const v = q.result; ops[id] = v ? { status: v.status, client_op_id: v.client_op_id, operation_type: v.operation_type, created_at: v.created_at, tenant_id: (v.scope || {}).tenant_id } : null; if (--left === 0) { db.close(); res(); } };
          q.onerror = () => { ops[id] = { error: String(q.error) }; if (--left === 0) { db.close(); res(); } };
        }
      };
      r.onerror = () => res();
    });
  }
  return {
    version, identifier, href: location.href,
    localStorageKeys: ls,
    lsMarker: localStorage.getItem('qa_staging_marker'),
    deviceIdentity: localStorage.getItem('breadee-desktop-device'),
    printerConfig: localStorage.getItem('breadee-desktop-printers'),
    idbMarker: qa, idb, ops,
  };
}
"""

SEED_JS = SNAPSHOT_JS + r"""
(async () => {
  const marker = 'qastaging1038-' + Date.now();
  localStorage.setItem('qa_staging_marker', marker);
  // Device identity: the app mints it on first boot; plant one only if the app has not yet.
  if (!localStorage.getItem('breadee-desktop-device')) {
    localStorage.setItem('breadee-desktop-device', JSON.stringify({ device_id: 'qa-dev-' + marker, terminal_id: 'qa-term', device_name: 'QA Staging PC', created_at: new Date().toISOString() }));
  }
  // Printer configuration (lib/printers.ts RoutingConfig shape).
  localStorage.setItem('breadee-desktop-printers', JSON.stringify({ printers: [{ id: 'qa-printer-' + marker, name: 'QA Cashier 80mm', connection: 'system', paper: '80mm', role: 'cashier', is_default: true }], categoryRouting: {}, itemOverrides: {} }));
  await new Promise((res, rej) => {
    const r = indexedDB.open('qa-staging-marker', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').put({ marker, at: new Date().toISOString() }, 'k'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  });
  // The app's own Dexie database must already exist (created by 1.0.37 at boot) - never create it here.
  let have = false;
  for (let i = 0; i < 60 && !have; i++) { have = (await indexedDB.databases()).some((d) => d.name === 'breadee-desktop'); if (!have) await new Promise((r) => setTimeout(r, 1000)); }
  if (!have) throw new Error('breadee-desktop IndexedDB not created by the 1.0.37 app');
  const dev = JSON.parse(localStorage.getItem('breadee-desktop-device'));
  const scope = { tenant_id: 'qa-tenant-1038', branch_id: 'qa-branch-1038', device_id: dev.device_id, terminal_id: dev.terminal_id, cashier_user_id: 'qa-user-1038' };
  const mk = (id, status, err) => ({
    operation_id: id, operation_type: 'takeaway_sale', schema_version: 1, scope, created_at: new Date().toISOString(),
    client_op_id: id + '-cop', local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: { qa_marker: marker }, status, retry_count: err ? 1 : 0, last_attempt_at: err ? new Date().toISOString() : null,
    last_error_code: err, last_error_message: err ? 'QA planted needs-attention operation' : null, result_meta: null, synced_at: null,
  });
  const opIds = ['qa1038-pending-' + marker, 'qa1038-na-' + marker];
  const preVersion = await new Promise((res, rej) => {
    const r = indexedDB.open('breadee-desktop');
    r.onsuccess = () => {
      const db = r.result; const v = db.version;
      if (!Array.from(db.objectStoreNames).includes('operations')) { db.close(); return rej(new Error('no operations store at v' + v)); }
      const tx = db.transaction('operations', 'readwrite');
      tx.objectStore('operations').put(mk(opIds[0], 'pending', null));
      tx.objectStore('operations').put(mk(opIds[1], 'needs_attention', 'QA_PLANTED'));
      tx.oncomplete = () => { db.close(); res(v); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    };
    r.onerror = () => rej(r.error);
  });
  return Object.assign(await __qaSnap(opIds), { planted: marker, opIds, breadeeDbVersionAtSeed: preVersion });
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
        ids = json.load(open(seed_path, encoding="utf-8")).get("opIds", []) if seed_path else []
        # Give the 1.0.38 app time to boot and run its Dexie v12 upgrade before reading.
        time.sleep(15)
        result.update(ev(ws, SNAPSHOT_JS + "\n__qaSnap(" + json.dumps(ids) + ")"))
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
