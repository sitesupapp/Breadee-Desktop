# Breadee Desktop 1.0.36 — isolated in-app updater test (unmodified production binary)

**Why this shape:** the 1.0.35 production build bakes its updater endpoint at compile time
(`https://raw.githubusercontent.com/sitesupapp/Breadee-Desktop/desktop-production-channel/latest.json`),
has **no runtime override**, and staging builds **disable the updater entirely** (`isUpdaterAvailable()`
returns false unless `IS_PRODUCTION`). So the only way to feed the *unmodified* production 1.0.35 a
test manifest **without touching the fleet** is to redirect that one URL on a single isolated QA box.
This test exercises the real updater path end-to-end (fetch manifest → minisign-verify → download →
install → relaunch) and never advances the production `latest.json`.

The embedded pubkey is `B77999D821F82FD7`; the 1.0.36 signature has already been verified
cryptographically against it (rsign2: "Signature and comment signature verified").

## Prerequisites (QA box only — a throwaway/VM Windows machine, offline from the fleet)
- The signed artifact (download + unzip): https://github.com/sitesupapp/Breadee-Desktop/actions/runs/38817031890/artifacts/12034797863
  → `Breadee_1.0.36_x64-setup.exe` (SHA-256 `56c7b8187fa818132a0cd5b19538359271016686aaf63d65106d74df247160ab`)
- The current production **1.0.35** installer (from release `desktop-prod-v1.0.35`).
- `mkcert` (https://github.com/FiloSottile/mkcert) and Python 3 (or Caddy — see note).
- Admin rights (to edit hosts + trust a local CA).

## Steps
1. **Lay out the served files** (exact paths the app requests):
   ```
   mkdir -p serve/sitesupapp/Breadee-Desktop/desktop-production-channel
   copy qa_latest.json serve/sitesupapp/Breadee-Desktop/desktop-production-channel/latest.json
   copy Breadee_1.0.36_x64-setup.exe serve/sitesupapp/Breadee-Desktop/desktop-production-channel/Breadee_1.0.36_x64-setup.exe
   ```
   (`qa_latest.json` carries the real, verified signature and points its `url` at the same redirected host.)

2. **Trust a local cert for the endpoint host:**
   ```
   mkcert -install
   mkcert raw.githubusercontent.com          # produces raw.githubusercontent.com.pem + -key.pem
   ```

3. **Serve it over HTTPS on 443** from the `serve` dir (Python one-file server):
   ```python
   # qa_serve.py  (run:  python qa_serve.py)
   import http.server, ssl, functools
   h = functools.partial(http.server.SimpleHTTPRequestHandler, directory="serve")
   ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
   ctx.load_cert_chain("raw.githubusercontent.com.pem", "raw.githubusercontent.com-key.pem")
   s = http.server.HTTPServer(("127.0.0.1", 443), h)
   s.socket = ctx.wrap_socket(s.socket, server_side=True)
   print("serving https://127.0.0.1:443"); s.serve_forever()
   ```
   (Alternative, no Python: `caddy file-server --root serve --listen 127.0.0.1:443 --tls raw.githubusercontent.com.pem,raw.githubusercontent.com-key.pem`)

4. **Redirect the endpoint host to local** — add to `C:\Windows\System32\drivers\etc\hosts`:
   ```
   127.0.0.1 raw.githubusercontent.com
   ```
   (Verify: `curl -s https://raw.githubusercontent.com/sitesupapp/Breadee-Desktop/desktop-production-channel/latest.json` returns the QA manifest.)

5. **Install + launch production 1.0.35.** Confirm the About/version shows **1.0.35**.

6. **Trigger the in-app updater** (Settings → About → Check for updates, or let the startup check run).
   Expected: it detects **1.0.36**, verifies the signature, downloads, installs, and prompts relaunch.

7. **Relaunch → confirm 1.0.36.** Open POS and sanity-check the cumulative features:
   R3 Merge (incl. partially-paid), R4 Force End Shift, R5 owner POS access, R6 customer accounts,
   R7 end-shift approval. No updater/signature errors.

8. **PASS criteria:** the app upgraded in-app from 1.0.35 → 1.0.36 via its own updater (signature
   accepted, installed, relaunched), and the features work.

## Cleanup (important)
- Remove the `127.0.0.1 raw.githubusercontent.com` hosts line.
- `mkcert -uninstall` (removes the local CA from the trust store).
- Discard the QA VM/box.

## Note
This never touches `desktop-production-channel/latest.json` on GitHub — the production fleet stays on
1.0.35 until, after this test passes, you authorize me to publish the GitHub release + advance the real
`latest.json`.
