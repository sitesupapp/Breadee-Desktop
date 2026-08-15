// One update state for the whole app.
//
// The banner and the Settings > About panel are two views of the SAME check, and
// that is the point: two independent updater states would eventually disagree -
// the banner still offering an update the settings screen had already installed,
// or a second click starting a second download of the same file.
//
// Nothing here talks to Tauri directly; `lib/updater` owns that boundary.

import { create } from "zustand";
import {
  CURRENT_VERSION,
  checkForUpdate,
  clearPendingUpdate,
  downloadAndInstall,
  isUpdaterAvailable,
  relaunchApp,
  type UpdateState,
} from "@/lib/updater";

type UpdatesState = {
  state: UpdateState;
  /** The current app version, for display. */
  version: string;
  /** Dismissed with "Later" - suppresses the banner without forgetting the update. */
  dismissed: boolean;
  /** True once the one automatic startup check has been attempted. */
  startupChecked: boolean;

  check: (options: { silent: boolean }) => Promise<void>;
  checkOnStartup: () => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
};

/**
 * Is an install already in flight?
 *
 * The duplicate-click guard. Kept OUTSIDE the store and checked synchronously,
 * because two clicks landing in the same tick would both read the same store
 * snapshot and both pass a state-based check - the same reason the payment and
 * reversal paths use a synchronous latch rather than a React state flag.
 */
let installing = false;

/** Startup check runs once per process, however many components mount. */
let startupStarted = false;

export const useUpdates = create<UpdatesState>((set, get) => ({
  state: { kind: "idle" },
  version: CURRENT_VERSION,
  dismissed: false,
  startupChecked: false,

  check: async (options) => {
    if (installing) return;
    if (get().state.kind === "checking") return;
    set({ state: { kind: "checking" } });
    const result = await checkForUpdate(options);
    // A fresh check supersedes an earlier dismissal: if the user said "Later"
    // and then deliberately pressed "Check for updates", they want to see it.
    set({ state: result, dismissed: options.silent ? get().dismissed : false });
  },

  checkOnStartup: async () => {
    if (startupStarted) return;
    startupStarted = true;
    if (!isUpdaterAvailable()) {
      set({ startupChecked: true });
      return;
    }
    await get().check({ silent: true });
    set({ startupChecked: true });
  },

  install: async () => {
    // Synchronous, before any await - see `installing` above.
    if (installing) return;
    const current = get().state;
    if (current.kind !== "available") return;
    installing = true;
    try {
      await downloadAndInstall((s) => set({ state: s }));
    } finally {
      installing = false;
    }
  },

  restart: async () => {
    if (get().state.kind !== "ready") return;
    await relaunchApp();
  },

  dismiss: () => {
    clearPendingUpdate();
    set({ dismissed: true, state: { kind: "idle" } });
  },
}));

/** Should the banner be on screen right now? */
export function shouldShowBanner(s: UpdatesState): boolean {
  if (s.dismissed) return false;
  // Errors never reach the banner. A till that cannot see GitHub is a till that
  // works fine, and telling the cashier about it every morning trains them to
  // ignore the one message that will eventually matter.
  return s.state.kind === "available" || s.state.kind === "downloading" || s.state.kind === "installing" || s.state.kind === "ready";
}
