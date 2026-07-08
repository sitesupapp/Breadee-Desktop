# App icons

Tauri needs generated icon files here (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, `icon.icns`).

Generate them from a single 1024×1024 PNG (placeholder is fine for Phase 1):
```bash
npm run tauri icon path/to/breadee-1024.png
```
This populates `src-tauri/icons/` automatically. Until then, `tauri build` will error on missing icons — generate first.
