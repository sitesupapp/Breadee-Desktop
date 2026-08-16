// Applying a theme, and remembering it for THIS installation only.
//
// LOCAL, AND ONLY LOCAL. The selected theme is written to `localStorage` on the
// terminal that chose it. It is never sent to the server, never attached to a
// tenant, branch, user or shift, and there is no code path from this module to
// Supabase - so activating a theme on the till by the door cannot change the
// till by the window, another branch, the web app, or anybody's permissions.
// `test/desktop-themes.test.ts` asserts the absence of that path directly.
//
// WHY IT SURVIVES A RESTART. `localStorage` in a Tauri webview is backed by the
// WebView2 user-data directory, which lives with the installation, so the value
// outlives navigation, sign-out, an app restart and a reboot. Sign-out
// deliberately does NOT clear it: the theme belongs to the terminal, not to
// whoever is standing at it.
//
// WHY IT IS APPLIED BEFORE REACT. `main.tsx` calls `bootTheme()` before
// `createRoot`, so the first painted frame is already themed. Applying it from
// an effect would show one frame of the default palette on every launch.

import { ALL_TOKENS, cssVarName, type Rgb, type ThemeToken } from "@/lib/theme/tokens";
import { DEFAULT_THEME_ID, STATUS_SETS, isThemeId, themeById, type ThemeDefinition, type ThemeId } from "@/lib/theme/themes";

/** Where the choice lives. Namespaced so it cannot collide with POS keys. */
export const THEME_STORAGE_KEY = "breadee.desktop.theme";

/**
 * Every token value for a theme: its own core colours plus the status set its
 * mode selects. This is the whole of what a theme can change.
 */
export function themeVariables(theme: ThemeDefinition): Record<ThemeToken, Rgb> {
  return { ...theme.colors, ...STATUS_SETS[theme.mode] } as Record<ThemeToken, Rgb>;
}

/**
 * Write a theme onto an element (in practice `<html>`).
 *
 * SETS CUSTOM PROPERTIES AND TWO ATTRIBUTES, AND NOTHING ELSE. It does not add
 * a class, touch `style` beyond `--c-*`, insert a stylesheet, or read anything
 * from the DOM - so there is no mechanism by which it could alter layout or
 * behaviour even if a theme wanted to.
 *
 * `color-scheme` comes along because it is the only way to tell the webview to
 * draw its own furniture - scrollbars, the caret, native form controls - dark.
 * Without it a dark theme has light scrollbars down the side of every panel.
 */
export function applyTheme(theme: ThemeDefinition, root: HTMLElement): void {
  const vars = themeVariables(theme);
  for (const token of ALL_TOKENS) {
    root.style.setProperty(cssVarName(token), vars[token]);
  }
  root.style.colorScheme = theme.mode;
  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-theme-mode", theme.mode);
}

/**
 * The theme this installation has chosen, or the default.
 *
 * Never throws. A webview with storage disabled, a corrupted value, or an id
 * from a newer build that has since been removed all resolve to Classic Green,
 * because a terminal that cannot read a preference must still be able to sell
 * things.
 */
export function readStoredThemeId(storage?: Pick<Storage, "getItem">): ThemeId {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    const raw = store?.getItem(THEME_STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Remember a choice. Silently a no-op when storage is unavailable. */
export function storeThemeId(id: ThemeId, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    store?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* A terminal with no storage still runs; it just forgets the choice. */
  }
}

/**
 * Apply the remembered theme. Called once, from `main.tsx`, before React.
 *
 * Returns the theme it applied so the store can start from the same value
 * rather than re-reading storage and risking a different answer.
 */
export function bootTheme(): ThemeDefinition {
  const theme = themeById(readStoredThemeId());
  if (typeof document !== "undefined") applyTheme(theme, document.documentElement);
  return theme;
}

/** Activate a theme now and remember it. The only write path in the feature. */
export function activateTheme(id: ThemeId): ThemeDefinition {
  const theme = themeById(id);
  if (typeof document !== "undefined") applyTheme(theme, document.documentElement);
  storeThemeId(theme.id);
  return theme;
}

/**
 * Theme variables as an inline `style` object, for a PREVIEW subtree.
 *
 * Preview is scoped rather than global on purpose: hovering a theme card must
 * not repaint the application around it, because a cashier comparing two
 * themes should still be able to read the screen they are standing in front of.
 * The returned object contains only `--c-*` entries, so a preview cannot leak
 * anything but colour into the subtree it decorates.
 */
export function themeStyle(theme: ThemeDefinition): Record<string, string> {
  const vars = themeVariables(theme);
  const style: Record<string, string> = {};
  for (const token of ALL_TOKENS) style[cssVarName(token)] = vars[token];
  style.colorScheme = theme.mode;
  return style;
}
