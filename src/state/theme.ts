// The active theme, as the UI sees it.
//
// A one-field store. It exists so the Themes screen can show which card is
// active and re-render when that changes; nothing else in the application reads
// it, because everything else is themed through CSS custom properties and never
// needs to know which theme produced them.
//
// NOTE WHAT IS NOT HERE: no tenant, no branch, no user, no permissions, no
// business state of any kind. A theme store that knew about an order would be a
// theme that could be blamed for one.

import { create } from "zustand";
import { activateTheme, readStoredThemeId } from "@/lib/theme/apply";
import { DEFAULT_THEME_ID, type ThemeId } from "@/lib/theme/themes";

export type ThemeState = {
  themeId: ThemeId;
  /** Activate and persist. Synchronous: the repaint happens in this tick. */
  setTheme: (id: ThemeId) => void;
};

export const useTheme = create<ThemeState>((set) => ({
  // Read from storage rather than assumed, so the store agrees with the
  // variables `bootTheme()` has already written to <html>.
  themeId: typeof window === "undefined" ? DEFAULT_THEME_ID : readStoredThemeId(),
  setTheme: (id) => {
    const applied = activateTheme(id);
    set({ themeId: applied.id });
  },
}));
