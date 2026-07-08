# Release & distribution (Windows, Phase 1)

## Build the installer
```powershell
# with Rust + MSVC installed:
npm run tauri:build
# output: src-tauri/target/release/bundle/nsis/Breadee_0.1.0_x64-setup.exe
```
The NSIS installer installs as **Breadee**, per-user (no admin), and can create Start-menu/desktop shortcuts.

## GitHub Releases
1. Ensure the repo `sitesupapp/Breadee-Desktop` exists (private).
2. Tag a release from `desktop-staging` (or `main` after approval):
   ```bash
   git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
   ```
3. Create the release and upload the `*-setup.exe` (via the GitHub web UI, or `gh release create desktop-v0.1.0 <path-to-setup.exe> --prerelease`).
4. Mark **pre-release** until Phase 1 is approved.

## Private website download link (later)
- Host the signed installer behind an authenticated link, or use a GitHub Release asset URL gated by your site.
- Do not expose production installers publicly until approved.

## Auto-update (future, not enabled in Phase 1)
- Tauri Updater plugin can check a JSON manifest (e.g. a GitHub Release `latest.json`) and prompt users.
- Phase 1 ships **manual installer only**; the app shows a "new version available" notice once the updater endpoint is added.
- Requires code signing for a trustworthy update experience (Windows: an EV/OV code-signing cert to avoid SmartScreen warnings).
