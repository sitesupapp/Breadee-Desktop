// The receipt template model - the SAME one the Breadee web app stores.
//
// ONE SCHEMA, TWO RENDERERS. `pos_receipt_settings.customer_template_config`
// and `kitchen_template_config` hold `{ blocks: [{ key, show }], size }`, written
// by the web app's Receipt Design page and by this app through the same
// `save_pos_receipt_settings` RPC. The desktop does NOT invent a second schema,
// a second column or a local copy; it edits the tenant's real configuration.
//
// THE TWO RENDERERS ARE GENUINELY DIFFERENT, AND THAT IS FINE. The web renders
// the receipt as HTML and prints it through a browser or the local bridge; the
// desktop hands a typed document to a Windows GDI renderer. What they share is
// the DECISION - which blocks appear, in which order - not the drawing code.
//
// WHICH IS WHY `SUPPORT` EXISTS. A handful of web blocks have no counterpart in
// the desktop's native document: a bitmap logo (GDI has no image path here), the
// loyalty summary, and the paid/balance split (the desktop receipt states one
// settled total). Those keys are NOT dropped, NOT silently ignored and NOT
// quietly toggled - they are carried through every save untouched and shown in
// the editor as "not printed by the desktop", so a tenant who configured them in
// the web app keeps them and knows why they do not appear here.
//
// PRESERVATION IS THE POINT. `normalizeTemplate` keeps every key the WEB
// catalog knows about, in its stored order and visibility. If it narrowed the
// list to what the desktop can draw, the first desktop save would delete the
// tenant's logo and loyalty settings from the shared row.

export type ReceiptKind = "customer" | "kitchen";

export type BlockConfig = { key: string; show: boolean };

/** Typography/spacing scale. Rides in the same JSONB the web already stores. */
export const RECEIPT_SIZES = ["compact", "normal", "large"] as const;
export type ReceiptSize = (typeof RECEIPT_SIZES)[number];

export type TemplateConfig = { blocks: BlockConfig[]; size: ReceiptSize };

export function resolveSize(value: unknown): ReceiptSize {
  const v = String(value ?? "").trim().toLowerCase();
  return (RECEIPT_SIZES as readonly string[]).includes(v) ? (v as ReceiptSize) : "normal";
}

/**
 * How the desktop's native renderer treats a block.
 *
 *   `printed`      - the desktop draws it, and the toggle controls that.
 *   `not_printed`  - the web draws it; the desktop has no field for it. The
 *                    toggle is shown read-only so the tenant can see the
 *                    setting they made elsewhere without changing it here.
 */
export type BlockSupport = "printed" | "not_printed";

export type BlockSpec = {
  key: string;
  label: string;
  kinds: ReceiptKind[];
  support: BlockSupport;
  /** Why the desktop cannot print it, when it cannot. */
  note?: string;
};

/**
 * Transcribed from `src/lib/receipt.ts` in the web app (BLOCK_CATALOG).
 *
 * The KEYS and KINDS must match the web exactly - they are the shared wire
 * format. The `support`/`note` columns are desktop metadata and are never
 * written anywhere.
 */
export const BLOCK_CATALOG: BlockSpec[] = [
  { key: "logo", label: "Logo", kinds: ["customer"], support: "not_printed", note: "The desktop prints text only; the logo image appears on web-printed receipts." },
  { key: "business_name", label: "Restaurant name", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "branch_name", label: "Branch name", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "address", label: "Address", kinds: ["customer"], support: "printed" },
  { key: "phone", label: "Phone", kinds: ["customer"], support: "printed" },
  { key: "welcome", label: "Welcome message", kinds: ["customer"], support: "printed" },
  { key: "order_number", label: "Order number", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "order_type", label: "Order type", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "table_info", label: "Table (dine-in)", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "customer_info", label: "Customer & delivery reference", kinds: ["kitchen"], support: "printed" },
  { key: "customer_name", label: "Customer name (delivery)", kinds: ["customer"], support: "printed" },
  { key: "customer_phone", label: "Customer phone (delivery)", kinds: ["customer"], support: "printed" },
  { key: "customer_address", label: "Delivery address", kinds: ["customer"], support: "printed" },
  { key: "customer_notes", label: "Delivery notes", kinds: ["customer"], support: "not_printed", note: "The desktop receipt carries no delivery-note field." },
  { key: "staff", label: "Cashier / server", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "datetime", label: "Date & time", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "items", label: "Items, quantities and modifiers", kinds: ["kitchen", "customer"], support: "printed" },
  { key: "subtotal", label: "Subtotal", kinds: ["customer"], support: "printed" },
  { key: "discount", label: "Discount", kinds: ["customer"], support: "printed" },
  { key: "total", label: "Total", kinds: ["customer"], support: "printed" },
  { key: "paid", label: "Paid amount", kinds: ["customer"], support: "not_printed", note: "The desktop receipt prints one settled total plus tendered and change." },
  { key: "balance", label: "Balance / unpaid", kinds: ["customer"], support: "not_printed", note: "A desktop receipt is produced after settlement, so there is no outstanding balance to print." },
  { key: "payment_method", label: "Payment method", kinds: ["customer"], support: "printed" },
  { key: "loyalty", label: "Loyalty summary", kinds: ["customer"], support: "not_printed", note: "Loyalty is not part of the desktop POS yet." },
  { key: "footer", label: "Footer message", kinds: ["kitchen", "customer"], support: "printed" },
];

export const BLOCK_BY_KEY: Record<string, BlockSpec> = Object.fromEntries(
  BLOCK_CATALOG.map((b) => [b.key, b]),
);

function catalogFor(kind: ReceiptKind): BlockSpec[] {
  return BLOCK_CATALOG.filter((b) => b.kinds.includes(kind));
}

/** Defaults, matching the web app's DEFAULT_KITCHEN / DEFAULT_CUSTOMER. */
export function defaultTemplate(kind: ReceiptKind): TemplateConfig {
  return {
    blocks: catalogFor(kind).map((b) => ({
      key: b.key,
      // The web ships the kitchen footer OFF and everything else ON.
      show: !(kind === "kitchen" && b.key === "footer"),
    })),
    size: "normal",
  };
}

/**
 * Make a stored config usable without losing anything.
 *
 * Drops keys this KIND does not have (a customer block in the kitchen config is
 * meaningless and the web drops it too), keeps stored order and visibility, and
 * appends any catalog block the stored config predates - so a tenant who saved
 * before a block existed sees it rather than having it silently hidden.
 */
export function normalizeTemplate(kind: ReceiptKind, raw: unknown): TemplateConfig {
  const allowed = new Set(catalogFor(kind).map((b) => b.key));
  const source = raw && typeof raw === "object" ? (raw as { blocks?: unknown; size?: unknown }) : {};
  const seen = new Set<string>();
  const blocks: BlockConfig[] = [];

  if (Array.isArray(source.blocks)) {
    for (const entry of source.blocks) {
      if (!entry || typeof entry !== "object") continue;
      const key = (entry as { key?: unknown }).key;
      if (typeof key !== "string" || !allowed.has(key) || seen.has(key)) continue;
      blocks.push({ key, show: (entry as { show?: unknown }).show === true });
      seen.add(key);
    }
  }
  for (const b of defaultTemplate(kind).blocks) {
    if (!seen.has(b.key)) {
      blocks.push({ key: b.key, show: b.show });
      seen.add(b.key);
    }
  }
  return { blocks, size: resolveSize(source.size) };
}

/** Flip one block's visibility, preserving order and every other block. */
export function toggleBlock(config: TemplateConfig, key: string): TemplateConfig {
  return {
    ...config,
    blocks: config.blocks.map((b) => (b.key === key ? { ...b, show: !b.show } : b)),
  };
}

export function setTemplateSize(config: TemplateConfig, size: ReceiptSize): TemplateConfig {
  return { ...config, size };
}

/**
 * The block keys the renderer should draw, in stored order.
 *
 * A block that is switched on but that the desktop cannot draw is EXCLUDED -
 * there is nothing to draw - so preview and paper agree. It stays in the
 * config, which is what keeps the web app's rendering of it intact.
 */
export function visibleBlocks(config: TemplateConfig): string[] {
  return config.blocks
    .filter((b) => b.show && BLOCK_BY_KEY[b.key]?.support === "printed")
    .map((b) => b.key);
}

/**
 * Membership test for a renderer.
 *
 * `null` sections mean "no template configured", and everything is drawn - the
 * behaviour every build before the designer existed had. A receipt that lost
 * its total because a settings row could not be read would be a far worse
 * failure than one that printed a line somebody had switched off.
 */
export function blockVisible(sections: readonly string[] | null | undefined, key: string): boolean {
  return !sections || sections.includes(key);
}
