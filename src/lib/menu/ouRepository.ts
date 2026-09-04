// THE OU-AWARE MENU BUILDER BACKEND — now a thin re-export.
//
// The implementation moved into `repository.ts` so there is genuinely ONE module
// in this feature that talks to Supabase (the model-parity guard). This file
// keeps the `@/lib/menu/ouRepository` import path its callers already use, but it
// imports NOTHING from `@/lib/supabase` and calls no RPC directly — every backend
// operation goes through the single repository door. Behaviour is identical.

export {
  listBranches,
  loadMenuBuilderOU,
  saveCategoryOU,
  saveItemOU,
  setItemPriceOU,
  setItemStatusOU,
  setItemAvailabilityOU,
  archiveItemOU,
  publishAllDraftsOU,
  saveGroupOU,
  archiveGroupOU,
  addOptionOU,
  archiveOptionOU,
  ensureQrSettingsOU,
  saveQrSettingsOU,
} from "@/lib/menu/repository";

export type { OUBranch, CategoryOUWrite, SaveItemOUInput } from "@/lib/menu/repository";
