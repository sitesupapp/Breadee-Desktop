# macOS build (prepared, not released in Phase 1)

The codebase is cross-platform (Tauri v2). macOS is **structurally ready** but a production Mac release is **out of scope for Phase 1** because an Apple Developer account is not ready.

## What already works for Mac
- Same Vite/React frontend and `src-tauri` config build for macOS targets.
- `tauri.conf.json` bundle can add `"dmg"` / `"app"` targets.

## What is required before a real Mac release
1. **Apple Developer Program** membership (paid).
2. **Signing**: a "Developer ID Application" certificate; set `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`.
3. **Notarization**: Apple ID + app-specific password (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) so Gatekeeper allows the app.
4. Build on macOS (Apple silicon + Intel or a universal binary): `npm run tauri build -- --target universal-apple-darwin`.

## Limitations without an Apple account
- Unsigned `.app`/`.dmg` will be blocked by Gatekeeper ("unidentified developer"); users must right-click → Open.
- No notarization; not suitable for public distribution.

## Recommended
Keep developing/testing on Windows for Phase 1. Add the Mac signing/notarization CI once the Apple account exists.
