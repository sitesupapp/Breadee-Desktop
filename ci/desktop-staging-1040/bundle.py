# RC-AUTH-1 (Staging 1.0.40): prove the UPDATED, running app executes the intended code. Reads every script
# the installed app's WebView actually loaded (served by the app itself from tauri.localhost) and counts:
#   - the local-scope sign-out call (`signOut({scope:"local"})`), and any sign-out call WITHOUT a scope;
#   - the replay classifier rule "42501 answered 401 is auth" (`===401?"auth":"business"`).
# usage: bundle.py <out_json>   (needs the app running with --remote-debugging-port=9222)
import json, sys, time, urllib.request
import websocket

out = sys.argv[1]

def target(wait_s=180):
    deadline = time.time() + wait_s
    while time.time() < deadline:
        try:
            ts = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=3))
            pages = [t for t in ts if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            app = [t for t in pages if "tauri.localhost" in str(t.get("url", ""))]
            if app:
                return app[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(2)
    raise SystemExit("CDP_UNAVAILABLE")

BUNDLE_JS = r"""
(async () => {
  const urls = new Set();
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src);
  for (const l of document.querySelectorAll('link[rel=modulepreload]')) urls.add(l.href);
  for (const e of performance.getEntriesByType('resource')) if (/\.js(\?|$)/.test(e.name)) urls.add(e.name);
  // supabase-js `_handleTokenChanged` carries `if (source == "STORAGE") this.auth.signOut()`; its only caller
  // (`_listenForAuthEvents`) passes "CLIENT", so that library branch never runs. It is counted apart
  // (libStorageBranch); every OTHER unscoped `.auth.signOut()` counts as bare, with its context as evidence.
  let localSignOut = 0, bareSignOut = 0, libStorageBranch = 0, classifier = 0, scanned = 0;
  const bareContexts = [];
  for (const u of urls) {
    try {
      const t = await (await fetch(u)).text();
      scanned++;
      localSignOut += (t.match(/\.signOut\(\{scope:"local"\}\)/g) || []).length;
      for (const m of t.matchAll(/\.auth\.signOut\(\)/g)) {
        const before = t.slice(Math.max(0, m.index - 40), m.index);
        if (/[=!]=+"STORAGE"\)?(&&)?this$/.test(before)) libStorageBranch++;
        else { bareSignOut++; bareContexts.push(t.slice(Math.max(0, m.index - 80), m.index + 40)); }
      }
      if (/===401\?"auth":"business"/.test(t)) classifier++;
    } catch (e) {}
  }
  let version = null;
  try { version = await window.__TAURI_INTERNALS__.invoke('plugin:app|version'); } catch (e) {}
  return { version, scanned, localSignOut, bareSignOut, bareContexts, libStorageBranch, classifier, assets: Array.from(urls).map((u) => u.replace(/^.*\//, '')) };
})()
"""

ws = websocket.create_connection(target(), timeout=30, suppress_origin=True)
try:
    ws.settimeout(120)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": BUNDLE_JS, "awaitPromise": True, "returnByValue": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == 1:
            break
    if "error" in m or "exceptionDetails" in m.get("result", {}):
        raise SystemExit("BUNDLE_EVAL_FAILED " + json.dumps(m)[:800])
    result = m["result"]["result"].get("value")
finally:
    try:
        ws.close()
    except Exception:
        pass

with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2)[:4000])
