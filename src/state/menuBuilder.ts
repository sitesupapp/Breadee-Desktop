// Menu Builder session state.
//
// ONE STORE, ONE MUTATION PATH. Every write in this feature goes through
// `mutate()`, which does four things in a fixed order and cannot be talked out
// of any of them:
//
//   1. Refuses a second run of the same operation key while the first is in
//      flight. That is the duplicate-submit guard, and it lives here rather than
//      in each button's disabled prop so a keyboard repeat, a double click and a
//      re-render all hit the same lock.
//   2. Awaits the backend. There is no optimistic write of an item, a price, a
//      category or a modifier - the UI shows the previous value until the server
//      has confirmed the new one.
//   3. RE-READS authoritative state after success. This is also the concurrency
//      answer: these tables carry no version column and the web app performs no
//      compare-and-set, so inventing one here would be a desktop-only contract.
//      What the desktop guarantees instead is that it never leaves a stale row
//      on screen after its own write - and that a Web edit appears on the next
//      read.
//   4. Reports the failure honestly on error, through `menuFailure`.
//
// The optimistic exception the brief allows - reordering and availability - is
// handled by `mutate` returning fast enough that no separate optimistic path is
// needed: both are single-column updates followed by a refresh, and a failure
// restores the previous list because the list is only ever the server's.

import { create } from "zustand";
import { loadMenuBuilderOU, listBranches, type OUBranch } from "@/lib/menu/ouRepository";
import { menuFailure, type MenuFailure } from "@/lib/menu/errors";
import { EMPTY_MENU_BUILDER_DATA, type MenuBuilderData } from "@/lib/menu/types";

export type MenuBuilderStatus = "idle" | "loading" | "ready" | "error";

export type MutationOutcome = { ok: true } | { ok: false; failure: MenuFailure };

// The Menu Builder now authors ONE Operating Unit. `branchId` is the SELECTED unit
// (null = nothing selected yet -> a blank, read-only workspace and no writes). There
// is no implicit Main: the operator must choose a unit before any operational write.
type MenuBuilderState = {
  status: MenuBuilderStatus;
  data: MenuBuilderData;
  /** Why the initial load failed. Never a raw fault - always `menuFailure`d. */
  loadError: MenuFailure | null;
  /** When the visible data was last read from the backend. */
  loadedAt: string | null;
  /** Operation keys currently in flight. */
  pending: string[];
  /** True while a post-write refresh is running, so the UI can show it. */
  refreshing: boolean;
  /** Operating Units the user may author, and the one currently selected. */
  branches: OUBranch[];
  branchesLoaded: boolean;
  branchId: string | null;
  loadBranches: (tenantId: string) => Promise<void>;
  /** Select an OU (or clear). Blanks the workspace immediately; caller then load()s. */
  setBranchId: (branchId: string | null) => void;
  load: (tenantId: string) => Promise<void>;
  refresh: (tenantId: string) => Promise<void>;
  mutate: (key: string, tenantId: string, action: string, run: () => Promise<void>) => Promise<MutationOutcome>;
  isPending: (key: string) => boolean;
  reset: () => void;
};

export const useMenuBuilder = create<MenuBuilderState>((set, get) => ({
  status: "idle",
  data: EMPTY_MENU_BUILDER_DATA,
  loadError: null,
  loadedAt: null,
  pending: [],
  refreshing: false,
  branches: [],
  branchesLoaded: false,
  branchId: null,

  loadBranches: async (tenantId) => {
    try {
      const branches = await listBranches(tenantId);
      set({ branches, branchesLoaded: true });
    } catch {
      set({ branches: [], branchesLoaded: true });
    }
  },

  setBranchId: (branchId) => {
    // Switching (or clearing) the OU blanks the workspace at once, so no stale
    // categories/items/modifiers from the previous unit are ever shown.
    set({ branchId, data: EMPTY_MENU_BUILDER_DATA, loadedAt: null, loadError: null, status: branchId ? "loading" : "ready" });
  },

  load: async (tenantId) => {
    const branchId = get().branchId;
    if (!branchId) {
      // No Operating Unit selected -> a genuinely blank workspace, never the tenant
      // catalog or Main. Nothing is loaded until the operator chooses a unit.
      set({ status: "ready", data: EMPTY_MENU_BUILDER_DATA, loadedAt: null, loadError: null });
      return;
    }
    set({ status: "loading", loadError: null });
    try {
      const data = await loadMenuBuilderOU(tenantId, branchId);
      set({ status: "ready", data, loadedAt: new Date().toISOString(), loadError: null });
    } catch (e) {
      set({ status: "error", loadError: menuFailure(e, "Loading the menu") });
    }
  },

  /**
   * Re-read the SELECTED unit without blanking the screen. A failed refresh does
   * NOT discard the data already on screen and does NOT flip into error state.
   */
  refresh: async (tenantId) => {
    const branchId = get().branchId;
    if (!branchId) return;
    set({ refreshing: true });
    try {
      const data = await loadMenuBuilderOU(tenantId, branchId);
      set({ data, loadedAt: new Date().toISOString(), status: "ready", loadError: null });
    } catch {
      /* keep the previous data; `loadedAt` still says when it was true */
    } finally {
      set({ refreshing: false });
    }
  },

  mutate: async (key, tenantId, action, run) => {
    if (get().pending.includes(key)) {
      return { ok: false, failure: { message: `${action} is already running.`, detail: null } };
    }
    set((s) => ({ pending: [...s.pending, key] }));
    try {
      await run();
      await get().refresh(tenantId);
      return { ok: true };
    } catch (e) {
      // Re-read anyway: a mutation can fail AFTER a partial change (an item row
      // saved, its price refused), and leaving the pre-write view on screen
      // would show the operator something the database no longer contains.
      await get().refresh(tenantId);
      return { ok: false, failure: menuFailure(e, action) };
    } finally {
      set((s) => ({ pending: s.pending.filter((k) => k !== key) }));
    }
  },

  isPending: (key) => get().pending.includes(key),

  reset: () => set({ status: "idle", data: EMPTY_MENU_BUILDER_DATA, loadError: null, loadedAt: null, pending: [], refreshing: false, branchId: null }),
}));
