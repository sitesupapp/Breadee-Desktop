// The public QR menu.
//
// ONE PUBLIC IDENTITY, NOT A DESKTOP COPY. `qr_menu_settings` is the row the web
// app writes, the row the public `/menu/<slug>` page reads, and the row the
// receipt designer already reads through `lib/pos/paymentQr.ts`. This tab edits
// THAT row - it does not mint a second slug, does not keep a desktop publish
// flag, and reuses `publicQrUrl` / `qrForSlug` / `QrSymbol` so the address shown
// here is byte-identical to the one printed on receipts.
//
// THE ROW IS THE ONE BRANCH-SCOPED THING IN THIS MODULE. Categories, items,
// groups and options are tenant-wide; `qr_menu_settings` is unique on
// `(tenant_id, branch_id)` and is created against the tenant's MAIN branch,
// exactly as the web workspace does.
//
// NO DOWNLOAD BUTTON, AND THAT IS DELIBERATE. The web app offers a PNG download;
// this application has no filesystem or dialog capability in
// `src-tauri/capabilities/default.json`, and widening that surface to save an
// image is a security decision, not a UI one. The link copies instead, and the
// same code prints on a receipt through Printing & Routing.

import { Badge, Button, Card, GatedButton, Input, cn } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { QrSymbol } from "@/components/pos/QrSymbol";
import { publicQrUrl, qrForSlug } from "@/lib/pos/paymentQr";
import type { MenuTheme, MenuThemeConfig, QrSettings } from "@/lib/menu/types";
import type { Gate } from "@/components/ui";

export function QrMenuTab({
  qr,
  themes,
  gate,
  busy,
  creating,
  onCreate,
  onPatch,
  onCopyLink,
}: {
  qr: QrSettings | null;
  themes: MenuTheme[];
  gate: Gate;
  busy: boolean;
  creating: boolean;
  onCreate: () => void;
  onPatch: (patch: Partial<QrSettings>) => void;
  onCopyLink: (url: string) => void;
}) {
  // A row with no slug is not a public menu: `public_slug` is nullable, and a
  // link built from an empty slug would point at the site root. Treat it exactly
  // as "not set up yet" rather than showing an address that goes nowhere.
  if (!qr || !qr.public_slug) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Card className="p-6">
          <p className="text-sm font-bold text-ink">This business has no public menu yet</p>
          <p className="mt-1 max-w-xl text-xs text-sub">
            Setting one up creates a permanent public web address for your menu and a QR code that points at it. Your
            items stay private until you switch the menu on.
          </p>
          <GatedButton gate={gate} className="mt-4" disabled={creating} onClick={onCreate}>
            {creating ? "Setting up…" : "Set up the public menu"}
          </GatedButton>
        </Card>
      </div>
    );
  }

  const url = publicQrUrl(qr.public_slug);
  const matrix = qrForSlug(qr.public_slug);
  const sorted = [...themes]
    .filter((t) => (t.config_json as unknown as MenuThemeConfig | null)?.key)
    .sort(
      (a, b) =>
        ((a.config_json as unknown as MenuThemeConfig).sort ?? 0) - ((b.config_json as unknown as MenuThemeConfig).sort ?? 0),
    );

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex shrink-0 flex-col items-center gap-2">
            {/* `bg-paper` is deliberately NOT themed - it is the white a QR must
                sit on to scan. Anything drawn on it must therefore use the paper
                ink tokens, not the theme's: measured on Black Ember, `text-sub`
                here rendered light grey on white at 1.1:1, i.e. invisible. */}
            <div className="rounded-xl border border-line bg-paper p-3">
              {matrix ? (
                <QrSymbol matrix={matrix} size={148} label="Public menu QR code" />
              ) : (
                <p className="text-xs font-semibold text-paper-sub">No code</p>
              )}
            </div>
            <Badge tone={qr.is_public ? "green" : "slate"}>{qr.is_public ? "Live" : "Not published"}</Badge>
          </div>

          <div className="min-w-[280px] flex-1 space-y-3">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-sub">Public link</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-slate-50 px-3 py-2.5 text-xs text-ink">
                  {url}
                </code>
                <Button variant="ghost" onClick={() => onCopyLink(url)}>
                  Copy
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-sub">
                The same address the web app prints on posters and table cards, and the same one your receipts can carry.
              </p>
            </div>

            <Switch
              checked={qr.is_public}
              disabled={!gate.allowed || busy}
              title={gate.reason ?? undefined}
              onChange={(v) => onPatch({ is_public: v })}
              label="Publish the public menu"
              hint="When off, the web address returns nothing. Your POS is unaffected either way."
            />
            <Switch
              checked={qr.show_prices}
              disabled={!gate.allowed || busy}
              title={gate.reason ?? undefined}
              onChange={(v) => onPatch({ show_prices: v })}
              label="Show prices on the public menu"
            />
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-sub">Appearance</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-sub">Welcome text</span>
            <Input
              defaultValue={qr.welcome_text ?? ""}
              disabled={!gate.allowed || busy}
              placeholder="e.g. Welcome to our menu"
              onBlur={(e) => {
                const next = e.target.value;
                if (next !== (qr.welcome_text ?? "")) onPatch({ welcome_text: next });
              }}
            />
          </label>
          {/* NO DEFAULT COLOUR IS INVENTED HERE. `qr_menu_settings.qr_color`
              carries the product's default at the database, so a literal in this
              file would be a second copy of it - and the theme tests rightly
              refuse a hex literal in a component. A row that genuinely holds no
              colour is reported as using the server's default rather than being
              silently shown as black. */}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-sub">QR colour</span>
            <span className="flex items-center gap-2">
              {qr.qr_color ? (
                <input
                  type="color"
                  defaultValue={qr.qr_color}
                  disabled={!gate.allowed || busy}
                  onBlur={(e) => {
                    if (e.target.value !== qr.qr_color) onPatch({ qr_color: e.target.value });
                  }}
                  className="h-11 w-14 rounded-xl border border-line bg-white"
                  aria-label="QR colour"
                />
              ) : (
                <span className="rounded-xl border border-line bg-slate-50 px-3 py-2.5 text-xs font-semibold text-sub">
                  Using the default
                </span>
              )}
              <span className="text-[11px] text-sub">
                Used by the web app and printed materials. The preview here stays black for scan contrast.
              </span>
            </span>
          </label>
        </div>
      </Card>

      {sorted.length > 0 && (
        <Card className="p-4">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-sub">Menu template</p>
          <p className="mb-3 text-xs text-sub">How your public menu looks. Changes apply immediately.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {sorted.map((theme) => {
              const config = theme.config_json as unknown as MenuThemeConfig;
              const selected = qr.theme_id === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  disabled={!gate.allowed || busy}
                  title={gate.reason ?? undefined}
                  onClick={() => onPatch({ theme_id: theme.id })}
                  className={cn(
                    "overflow-hidden rounded-xl border text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                    selected ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-slate-300",
                  )}
                >
                  {/* Literal colours on purpose: this is a swatch of the PUBLIC
                      menu's palette, not of this terminal's theme. Recolouring it
                      would make it a preview of a different page. */}
                  <span className="block h-7" style={{ background: config.primary }} />
                  <span className="block space-y-1 p-2" style={{ background: config.bg }}>
                    <span className="block h-2.5 w-2/3 rounded" style={{ background: config.card }} />
                    <span className="block h-2.5 w-1/2 rounded" style={{ background: config.card }} />
                  </span>
                  <span className="flex items-center justify-between gap-1 px-2 py-1.5 text-[11px] font-semibold text-ink">
                    <span className="truncate">{theme.name}</span>
                    {selected && <span className="text-brand-dark">✓</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
