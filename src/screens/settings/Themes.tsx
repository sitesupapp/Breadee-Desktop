// Settings -> Themes.
//
// APPEARANCE, FOR THIS TERMINAL. The heading says so, and the screen has no
// other write than `localStorage`: there is no RPC, no Supabase import and no
// tenant or branch anywhere in this file. Activating a theme here cannot change
// another till, another branch, the web app, a permission, a price or a printer.
//
// PREVIEW IS SCOPED, ACTIVATE IS GLOBAL. Pressing Preview themes the panel
// below and nothing else, so an operator can compare two themes while still
// reading the screen they are standing in front of. Pressing Activate writes
// the variables to <html> and remembers the choice; the repaint is one style
// recalculation, with no reload, no re-fetch and no POS state touched.

import { useState } from "react";
import { Badge, Button, Card, cn } from "@/components/ui";
import { PosThemePreview } from "@/components/theme/PosThemePreview";
import { rgbToHex } from "@/lib/theme/tokens";
import { swatches, THEME_LIST, themeById, type ThemeDefinition } from "@/lib/theme/themes";
import { useTheme } from "@/state/theme";

export function Themes() {
  const activeId = useTheme((s) => s.themeId);
  const setTheme = useTheme((s) => s.setTheme);
  // Null means "show the active theme", so closing a preview returns to the
  // truth rather than to whatever was previewed last.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewed: ThemeDefinition = themeById(previewId ?? activeId);
  const isPreviewing = previewId !== null && previewId !== activeId;

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Themes</h2>
            <p className="mt-1 text-sm text-sub">
              Appearance only, and only for this terminal. A theme changes colours across the whole app — Dashboard,
              POS, Orders, Profile, Settings, dialogs and the receipt designer. It never changes prices, permissions,
              printing, routing or how an order behaves.
            </p>
          </div>
          <Badge tone="slate">This installation</Badge>
        </div>
      </Card>

      {/* The large preview, shown once above the cards rather than inside each
          of them: ten full-size POS previews on one screen is ten times the
          layout work for a comparison nobody makes. */}
      <Card className="p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-extrabold text-ink">Live POS preview — {previewed.name}</p>
            <p className="text-xs text-sub">
              A picture of the POS layout. It takes no orders, reads no menu and touches no data.
            </p>
          </div>
          {isPreviewing && (
            <div className="flex items-center gap-2">
              <Badge tone="amber">Previewing</Badge>
              <Button size="sm" variant="ghost" onClick={() => setPreviewId(null)}>
                Back to active
              </Button>
              <Button size="sm" onClick={() => { setTheme(previewed.id); setPreviewId(null); }}>
                Activate {previewed.name}
              </Button>
            </div>
          )}
        </div>
        <PosThemePreview theme={previewed} variant="full" />
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {THEME_LIST.map((theme) => {
          const active = theme.id === activeId;
          return (
            <Card
              key={theme.id}
              className={cn("p-4", active && "border-2 border-brand", previewId === theme.id && !active && "border-2 border-amber-400")}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold text-ink">{theme.name}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-sub">{theme.description}</p>
                </div>
                {active ? (
                  <Badge tone="green">&#10003; Active</Badge>
                ) : (
                  <Badge tone={theme.mode === "dark" ? "slate" : "slate"}>{theme.mode === "dark" ? "Dark" : "Light"}</Badge>
                )}
              </div>

              <div className="mt-3">
                <PosThemePreview theme={theme} variant="compact" />
              </div>

              {/* Swatches carry a text label as well as a colour, because a
                  colour-only control is unusable to a colour-blind operator. */}
              <div className="mt-3 flex items-center gap-1.5">
                {swatches(theme).map((rgb, i) => (
                  <span
                    key={i}
                    title={rgbToHex(rgb)}
                    style={{ backgroundColor: `rgb(${rgb})` }}
                    className="h-5 w-5 rounded-md border border-line"
                  />
                ))}
                <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-sub">
                  {theme.mode}
                </span>
              </div>

              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => setPreviewId(theme.id)}
                  disabled={previewId === theme.id}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => { setTheme(theme.id); setPreviewId(null); }}
                  disabled={active}
                >
                  {active ? "Active" : "Activate"}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="p-4">
        <p className="text-xs text-sub">
          The selected theme is stored on this computer and survives sign-out, an app restart and a Windows restart. It
          is not part of your tenant configuration, so other terminals and the Breadee web app are unaffected.
        </p>
      </Card>
    </div>
  );
}
