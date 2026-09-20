// The Dine-In Floor DESIGNER foundation (Phase 3A), against the Phase-1 staging
// contract. This is the EDIT side of the floor; `lib/pos/floor.ts` is the read
// side. The two never share state.
//
// WHAT THIS OWNS (pure, testable, no React, no DOM):
//   * the DRAFT document contract — load, parse for rendering, and serialize back
//     WITHOUT losing anything the reader does not model (a future phase's staged
//     `temp_id`/`rename_to` table intent, an unknown element kind, an extra field
//     on a known element). Editing a floor must never silently drop part of it,
//     so the raw element objects are preserved verbatim and only the geometry of
//     the elements the operator actually moved is overwritten on save.
//   * the geometry of an edit — drag / resize / rotate — as plain transforms of
//     numbers in intrinsic LOGICAL units. Screen deltas are converted to logical
//     by dividing by the view scale; nothing viewport-shaped is ever persisted.
//   * the server error → friendly state mapping the Designer surfaces.
//   * the thin RPC boundary for the six Phase-1 draft/lease RPCs.
//
// WHAT THIS DOES NOT OWN: orders, bills, payments, shifts, table operational
// status, the canonical table selection. Those belong to `useTables` and the POS
// stores, and this module imports none of them. A Designer edit changes geometry
// in a draft; it can never open, pay, move or close a table.

import {
  asRecord,
  bool,
  callPosRpc,
  numOrNull,
  str,
  strOrNull,
} from "@/lib/pos/rpc";
import {
  parseFloorElement,
  sortSections,
  type FloorElement,
  type FloorSection,
} from "@/lib/pos/floor";

/** The smallest a table may be resized to, in intrinsic LOGICAL units. */
export const MIN_ELEMENT_LOGICAL = 24;
/** Rotation snaps to this increment — a clean angle without a protractor UI. */
export const ROTATE_SNAP_DEG = 15;

// --- The draft document ------------------------------------------------------

/** The mutable geometry of one element — the only thing Phase 3A edits. */
export type ElementGeom = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–359 integer. */
  rotation: number;
};

/**
 * A parsed draft: the sections and the renderable elements (reusing the reader's
 * defensive element parse), PLUS the untouched raw element objects so a save can
 * round-trip everything this build does not model. `rawElements` is the source of
 * truth for serialization; `elements` is the source of truth for rendering.
 */
export type ParsedDraft = {
  version: string;
  sections: FloorSection[];
  elements: FloorElement[];
  /** The document exactly as received, kept for lossless serialization. */
  rawDoc: Record<string, unknown>;
  rawElements: Record<string, unknown>[];
};

/** The lease state as `floor_draft` reports it. */
export type LeaseInfo = {
  ownerIsMe: boolean;
  active: boolean;
  lastSeenAt: string | null;
  expiresAt: string | null;
};

/** One unplaced table — a canonical table not present on the draft floor. */
export type UnplacedTable = {
  id: string;
  name: string;
  seats: number | null;
};

/** The whole `floor_draft` response, parsed. */
export type DraftLoad = {
  layoutId: string | null;
  /** null when this branch has never drafted or published a floor. */
  draft: ParsedDraft | null;
  draftHash: string | null;
  /** The CAS key every autosave/publish must echo — the live published revision. */
  publishedRevisionId: string | null;
  /** The base the draft was taken from (may lag the published revision). */
  draftBaseRevisionId: string | null;
  canPublish: boolean;
  unplaced: UnplacedTable[];
  lease: LeaseInfo | null;
};

const EMPTY_DOC: Record<string, unknown> = { v: "1", sections: [], elements: [] };

/** Parse a raw draft document into a lossless, renderable `ParsedDraft`. */
export function parseDraftDoc(docRaw: unknown): ParsedDraft {
  const doc = asRecord(docRaw);
  const version = str(doc.v, "1");
  const rawSections = Array.isArray(doc.sections) ? doc.sections : [];
  const rawElements = Array.isArray(doc.elements) ? doc.elements : [];

  const sections = sortSections(
    rawSections
      .map(parseDraftSection)
      .filter((s): s is FloorSection => s !== null),
  );
  const validSectionIds = new Set(sections.map((s) => s.id));
  const elements = rawElements
    .map(parseFloorElement)
    .filter((e): e is FloorElement => e !== null)
    .filter((e) => validSectionIds.has(e.sectionId));

  // Keep the raw element objects verbatim (only records survive; a non-object
  // entry could never be edited or serialized meaningfully and is dropped, which
  // matches what the parser already refuses to render).
  const keptRaw = rawElements.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
  );

  return {
    version,
    sections,
    elements,
    rawDoc: { ...EMPTY_DOC, ...doc },
    rawElements: keptRaw,
  };
}

/** A draft section parse — mirrors the reader's, kept local so `floor.ts` is untouched. */
function parseDraftSection(raw: unknown): FloorSection | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  const w = numOrNull(r.w);
  const h = numOrNull(r.h);
  return {
    id,
    name: str(r.name),
    sort: numOrNull(r.sort),
    w: w !== null && w > 0 ? w : null,
    h: h !== null && h > 0 ? h : null,
  };
}

/**
 * Serialize a draft back to a document, applying ONLY the geometry overrides the
 * operator produced and preserving every other element and field byte-for-byte.
 *
 * This is the safety guarantee that lets Phase 3A edit a floor a later phase's
 * document format can carry more of: an element with no override is emitted
 * exactly as it arrived, so a staged table intent, an unknown element kind or an
 * extra field is never lost by a round-trip through the editor.
 */
export function serializeDraftDoc(
  draft: ParsedDraft,
  overrides: Map<string, ElementGeom>,
): Record<string, unknown> {
  const elements = draft.rawElements.map((raw) => {
    const id = strOrNull(raw.id);
    const geom = id ? overrides.get(id) : undefined;
    if (!geom) return raw;
    return {
      ...raw,
      x: geom.x,
      y: geom.y,
      w: geom.w,
      h: geom.h,
      rotation: geom.rotation,
    };
  });
  return { ...draft.rawDoc, sections: draft.rawDoc.sections ?? [], elements };
}

/** True when a draft carries at least one renderable element to edit. */
export function draftHasContent(draft: ParsedDraft | null): boolean {
  return !!draft && draft.elements.length > 0;
}

// --- Geometry of an edit (pure) ----------------------------------------------

/** Normalize any angle to a 0–359 integer. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = Math.round(deg) % 360;
  return r < 0 ? r + 360 : r;
}

/** Snap an angle to the nearest `ROTATE_SNAP_DEG`, then normalize. */
export function snapRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return normalizeRotation(Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG);
}

/** The geometry of an element, read into an `ElementGeom`. */
export function geomOf(el: FloorElement): ElementGeom {
  return { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation };
}

/**
 * Move an element by a SCREEN delta at the current view scale. The delta is
 * converted to logical units; position is otherwise unconstrained (the plane can
 * grow — a table dragged past the current bounds simply extends the section).
 */
export function applyDrag(base: ElementGeom, screenDx: number, screenDy: number, scale: number): ElementGeom {
  const s = scale > 0 ? scale : 1;
  return { ...base, x: base.x + screenDx / s, y: base.y + screenDy / s };
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/**
 * Resize an element from one corner, keeping the OPPOSITE corner fixed, by a
 * screen delta at the current scale. Sizes are clamped to `MIN_ELEMENT_LOGICAL`;
 * when a clamp bites, the fixed corner still does not move.
 */
export function applyResize(
  base: ElementGeom,
  handle: ResizeHandle,
  screenDx: number,
  screenDy: number,
  scale: number,
  min = MIN_ELEMENT_LOGICAL,
): ElementGeom {
  const s = scale > 0 ? scale : 1;
  const dx = screenDx / s;
  const dy = screenDy / s;
  const left = base.x;
  const right = base.x + base.w;
  const top = base.y;
  const bottom = base.y + base.h;

  // Which edges the handle drives, and therefore which OPPOSITE edge is the fixed
  // anchor. Widths are SIGNED against the anchor and clamped to `min`, never taken
  // as an absolute — so dragging a corner past its anchor pins the size at `min`
  // rather than flipping the rectangle inside out.
  const east = handle === "se" || handle === "ne";
  const south = handle === "se" || handle === "sw";

  const w = east ? Math.max(min, right + dx - left) : Math.max(min, right - (left + dx));
  const h = south ? Math.max(min, bottom + dy - top) : Math.max(min, bottom - (top + dy));
  const x = east ? left : right - w;
  const y = south ? top : bottom - h;

  return { ...base, x, y, w, h };
}

/** Rotate to an absolute angle (already computed by the caller from the pointer). */
export function applyRotate(base: ElementGeom, deg: number, snap = true): ElementGeom {
  return { ...base, rotation: snap ? snapRotation(deg) : normalizeRotation(deg) };
}

// --- Server error mapping ----------------------------------------------------

export type FloorDesignerErrorKind =
  | "busy" // FLOOR_EDITOR_BUSY — another editor holds/held the lease
  | "stale" // FLOOR_STALE_REVISION — the live floor changed under us
  | "permission" // FLOOR_PERMISSION_DENIED / FLOOR_PUBLISH_PERMISSION_DENIED
  | "entitlement" // FLOOR_ENTITLEMENT_DISABLED — feature turned off
  | "invalid" // FLOOR_MALFORMED_DOC / validation
  | "network" // no response / offline
  | "unknown";

export type FloorDesignerError = {
  kind: FloorDesignerErrorKind;
  message: string;
  /** True when the editing session cannot safely continue and must go read-only. */
  readOnly: boolean;
};

const ERROR_MESSAGES: Record<FloorDesignerErrorKind, string> = {
  busy: "This floor is being edited on another device.",
  stale: "The live floor changed while you were editing. Reopen the designer to continue.",
  permission: "You do not have permission to edit this floor.",
  entitlement: "Floor editing is not enabled for this plan.",
  invalid: "That change couldn’t be saved — the floor layout was rejected.",
  network: "Couldn’t reach the server. Your changes are kept locally.",
  unknown: "Something went wrong while editing the floor.",
};

/** Classify a thrown RPC/network error into a Designer state. */
export function classifyFloorDesignerError(e: unknown): FloorDesignerError {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const kind = kindOf(raw);
  // A lost lease or a moved-out-from-under-us floor both mean: stop writing, keep
  // the operator's work, and drop to read-only. Entitlement/permission removal is
  // the same — the session cannot keep saving.
  const readOnly = kind === "busy" || kind === "stale" || kind === "permission" || kind === "entitlement";
  return { kind, message: ERROR_MESSAGES[kind], readOnly };
}

function kindOf(raw: string): FloorDesignerErrorKind {
  if (raw.includes("FLOOR_EDITOR_BUSY")) return "busy";
  if (raw.includes("FLOOR_STALE_REVISION")) return "stale";
  if (raw.includes("FLOOR_PUBLISH_PERMISSION_DENIED") || raw.includes("FLOOR_PERMISSION_DENIED")) return "permission";
  if (raw.includes("FLOOR_ENTITLEMENT_DISABLED")) return "entitlement";
  if (raw.includes("FLOOR_MALFORMED_DOC") || raw.includes("FLOOR_VALIDATION") || raw.includes("FLOOR_NOOP")) {
    return "invalid";
  }
  if (raw === "" || /network|fetch|timeout|Failed to fetch|offline/i.test(raw)) return "network";
  return "unknown";
}

// --- The RPC boundary (the six Phase-1 draft/lease RPCs) ---------------------

/** A short device tag for the lease, so "edited on another device" can be honest. */
export function draftDeviceTag(): string {
  if (typeof navigator !== "undefined" && navigator.platform) return `desktop:${navigator.platform}`;
  return "desktop";
}

function requireBranch(branchId: string | null): string {
  if (!branchId) throw new Error("A branch is required to edit the floor map");
  return branchId;
}

/** floor_draft — load the draft doc, lease and CAS keys for editing. */
export async function floorLoadDraft(branchId: string | null): Promise<DraftLoad> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_draft", { p_branch: b }));
  const draftDoc = r.draft_doc;
  const lease = r.lease === null || r.lease === undefined ? null : asRecord(r.lease);
  return {
    layoutId: strOrNull(r.layout_id),
    draft: draftDoc === null || draftDoc === undefined ? null : parseDraftDoc(draftDoc),
    draftHash: strOrNull(r.draft_hash),
    publishedRevisionId: strOrNull(r.published_revision_id),
    draftBaseRevisionId: strOrNull(r.draft_base_revision_id),
    canPublish: bool(r.can_publish),
    unplaced: parseUnplaced(r.unplaced),
    lease: lease
      ? {
          ownerIsMe: bool(lease.owner_is_me),
          active: bool(lease.active),
          lastSeenAt: strOrNull(lease.last_seen_at),
          expiresAt: strOrNull(lease.expires_at),
        }
      : null,
  };
}

/** Parse the `unplaced` payload (from floor_draft or floor_unplaced_tables). */
export function parseUnplaced(raw: unknown): UnplacedTable[] {
  if (!Array.isArray(raw)) return [];
  const out: UnplacedTable[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const id = strOrNull(r.id ?? r.table_id);
    if (!id) continue;
    out.push({ id, name: str(r.name), seats: numOrNull(r.seats) });
  }
  return out;
}

/** floor_unplaced_tables — the authoritative unplaced list for the draft. */
export async function floorLoadUnplaced(branchId: string | null): Promise<UnplacedTable[]> {
  const b = requireBranch(branchId);
  return parseUnplaced(await callPosRpc("floor_unplaced_tables", { p_branch: b }));
}

export type LeaseResult = { ok: boolean; layoutId: string | null; expiresAt: string | null; tookOver: boolean };

function parseLeaseResult(raw: unknown): LeaseResult {
  const r = asRecord(raw);
  return {
    ok: bool(r.ok),
    layoutId: strOrNull(r.layout_id),
    expiresAt: strOrNull(r.expires_at),
    tookOver: bool(r.took_over),
  };
}

/** floor_acquire_lease — claim the single editor lease for this floor. */
export async function floorAcquireLease(branchId: string | null, device = draftDeviceTag()): Promise<LeaseResult> {
  const b = requireBranch(branchId);
  return parseLeaseResult(await callPosRpc("floor_acquire_lease", { p_branch: b, p_device: device }));
}

/** floor_heartbeat — keep the held lease alive. Throws FLOOR_EDITOR_BUSY if lost. */
export async function floorHeartbeat(branchId: string | null): Promise<{ ok: boolean; expiresAt: string | null }> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_heartbeat", { p_branch: b }));
  return { ok: bool(r.ok), expiresAt: strOrNull(r.expires_at) };
}

/** floor_release_lease — hand the lease back on leaving the designer. */
export async function floorReleaseLease(branchId: string | null): Promise<{ ok: boolean }> {
  const b = requireBranch(branchId);
  const r = asRecord(await callPosRpc("floor_release_lease", { p_branch: b }));
  return { ok: bool(r.ok) };
}

/** floor_takeover_lease — claim an EXPIRED lease (still refuses an active one). */
export async function floorTakeoverLease(branchId: string | null, device = draftDeviceTag()): Promise<LeaseResult> {
  const b = requireBranch(branchId);
  return parseLeaseResult(await callPosRpc("floor_takeover_lease", { p_branch: b, p_device: device }));
}

/**
 * floor_autosave_draft — persist the draft geometry. Lease-protected and CAS-
 * guarded on the server (`p_base_revision_id` must equal the live published
 * revision); the caller passes the `publishedRevisionId` from the load.
 */
export async function floorAutosaveDraft(
  branchId: string | null,
  doc: Record<string, unknown>,
  baseRevisionId: string | null,
): Promise<{ ok: boolean; draftHash: string | null }> {
  const b = requireBranch(branchId);
  const r = asRecord(
    await callPosRpc("floor_autosave_draft", { p_branch: b, p_doc: doc, p_base_revision_id: baseRevisionId }),
  );
  return { ok: bool(r.ok), draftHash: strOrNull(r.draft_hash) };
}
