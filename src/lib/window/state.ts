// Desktop window behaviour.
//
// Everything here degrades to a no-op in a plain browser (dev server, tests), so
// the app is identical to run either way. Only APIs Tauri already grants under
// `core:default` are used - no new capability is requested for this level.

import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";

const STORAGE_KEY = "breadee-desktop-window";

/** Smallest window the POS layout is designed to remain usable in. */
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 720;

type SavedWindowState = {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function read(): SavedWindowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedWindowState>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    return {
      width: parsed.width,
      height: parsed.height,
      x: typeof parsed.x === "number" ? parsed.x : 0,
      y: typeof parsed.y === "number" ? parsed.y : 0,
      maximized: parsed.maximized === true,
    };
  } catch {
    return null;
  }
}

function write(state: SavedWindowState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* a full or blocked storage must never break the POS */
  }
}

/**
 * Restore the last window geometry, clamped to the current display so a window
 * saved on a monitor that is now unplugged still comes back on screen.
 */
export async function restoreWindowState(): Promise<void> {
  if (!isTauri()) return;
  const saved = read();
  if (!saved) return;
  try {
    const win = getCurrentWindow();
    if (saved.maximized) {
      await win.maximize();
      return;
    }
    const width = Math.max(saved.width, MIN_WINDOW_WIDTH);
    const height = Math.max(saved.height, MIN_WINDOW_HEIGHT);
    await win.setSize(new LogicalSize(width, height));
    const onScreen =
      saved.x > -width + 100 &&
      saved.y > -1 &&
      saved.x < globalThis.screen.width - 100 &&
      saved.y < globalThis.screen.height - 60;
    if (onScreen) await win.setPosition(new LogicalPosition(saved.x, saved.y));
  } catch {
    /* geometry is a convenience, never a startup blocker */
  }
}

/** Persist geometry on resize/move. Returns a disposer. */
export async function trackWindowState(): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const [size, position, maximized] = await Promise.all([
            win.innerSize(),
            win.outerPosition(),
            win.isMaximized(),
          ]);
          const factor = await win.scaleFactor();
          write({
            width: Math.round(size.width / factor),
            height: Math.round(size.height / factor),
            x: Math.round(position.x / factor),
            y: Math.round(position.y / factor),
            maximized,
          });
        } catch {
          /* ignore */
        }
      }, 400);
    };
    const unlistenResize = await win.onResized(save);
    const unlistenMove = await win.onMoved(save);
    return () => {
      window.clearTimeout(timer);
      unlistenResize();
      unlistenMove();
    };
  } catch {
    return () => {};
  }
}

/** Toggle fullscreen (kiosk). Falls back to the browser Fullscreen API outside Tauri. */
export async function toggleFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      return next;
    } catch {
      return false;
    }
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}
