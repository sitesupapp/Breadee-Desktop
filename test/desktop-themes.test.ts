// Desktop themes.
//
// Four properties these tests exist to protect.
//
// ONE, A THEME IS COLOUR AND NOTHING ELSE. The whole safety argument for
// shipping ten skins over a working POS is that a theme has no way to express
// layout, spacing, visibility or behaviour. That is checked here structurally -
// against the token vocabulary, against every theme definition, and against the
// source of the module that applies one - not asserted in prose.
//
// TWO, IT IS LOCAL. Activating a theme must not be able to reach the server,
// the tenant, a permission or another terminal. The strongest form of that
// check is that the theme modules import nothing that could.
//
// THREE, IT STAYS READABLE. Ten palettes hand-written by eye is ten chances to
// ship a till whose totals are grey on cream. Every theme's real text/background
// pairs are measured against WCAG here, so a bad palette fails the build rather
// than a service.
//
// FOUR, AN EXISTING INSTALLATION SEES NO CHANGE. Classic Green is pinned to the
// literal palette the app shipped with, in both the TypeScript definition and
// the CSS fallback, so an update cannot silently restyle a working terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import {
  ALL_TOKENS,
  CORE_TOKENS,
  STATUS_TOKENS,
  contrastRatio,
  cssVarName,
  hexToRgb,
  rgbToHex,
} from "@/lib/theme/tokens";
import {
  DEFAULT_THEME_ID,
  STATUS_SETS,
  THEMES,
  THEME_IDS,
  THEME_LIST,
  isThemeId,
  swatches,
  themeById,
} from "@/lib/theme/themes";
import {
  THEME_STORAGE_KEY,
  readStoredThemeId,
  storeThemeId,
  themeStyle,
  themeVariables,
} from "@/lib/theme/apply";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** A localStorage stand-in. Node has none, and a real one would leak between tests. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  };
}

// --- one, a theme is colour and nothing else ---------------------------------

test("there are exactly ten themes and their ids are unique", () => {
  assert.equal(THEME_IDS.length, 10);
  assert.equal(new Set(THEME_IDS).size, 10);
  assert.equal(THEME_LIST.length, 10);
  for (const id of THEME_IDS) assert.equal(THEMES[id].id, id, `${id} must know its own id`);
});

test("every theme supplies every core token and NOTHING else", () => {
  for (const theme of THEME_LIST) {
    const keys = Object.keys(theme.colors).sort();
    assert.deepEqual(keys, [...CORE_TOKENS].sort(), `${theme.id} must define exactly the core tokens`);
  }
});

test("a theme definition has no field that could change layout or behaviour", () => {
  // The type already forbids it; this catches a definition that grew an extra
  // property through a cast or a spread. Anything beyond these five is a new
  // capability nobody reviewed.
  const allowed = ["id", "name", "description", "mode", "colors"].sort();
  for (const theme of THEME_LIST) {
    assert.deepEqual(Object.keys(theme).sort(), allowed, `${theme.id} carries an unexpected field`);
  }
});

test("every token value is space-separated RGB channels, never a hex or a CSS value", () => {
  // Not pedantry: Tailwind's `<alpha-value>` placeholder needs unwrapped
  // channels, so a hex here would silently break every `bg-brand/40` and
  // `text-sub/70` already in the codebase.
  const channels = /^\d{1,3} \d{1,3} \d{1,3}$/;
  for (const theme of THEME_LIST) {
    const vars = themeVariables(theme);
    for (const token of ALL_TOKENS) {
      const value = vars[token];
      assert.match(value, channels, `${theme.id}.${token} = ${JSON.stringify(value)}`);
      for (const n of value.split(" ")) {
        assert.ok(Number(n) >= 0 && Number(n) <= 255, `${theme.id}.${token} channel out of range`);
      }
    }
  }
});

test("applying a theme sets custom properties and two attributes, and touches nothing else", () => {
  const source = stripComments(read("src/lib/theme/apply.ts"));
  // The only DOM writes allowed. `className`, `classList`, `innerHTML`,
  // `appendChild`, `insertRule` and a stylesheet would each be a way for a
  // theme to reach past colour.
  for (const forbidden of [
    "className",
    "classList",
    "innerHTML",
    "appendChild",
    "insertAdjacent",
    "insertRule",
    "createElement",
    "querySelector",
    "addEventListener",
  ]) {
    assert.ok(!source.includes(forbidden), `apply.ts must not use ${forbidden}`);
  }
  assert.ok(source.includes("setProperty"), "apply.ts sets custom properties");
  assert.ok(source.includes('setAttribute("data-theme"'), "apply.ts stamps the active theme id");
  assert.ok(source.includes("colorScheme"), "a dark theme must set color-scheme for the webview chrome");
});

test("the theme layer never reaches the server, the tenant or a permission", () => {
  for (const file of ["src/lib/theme/apply.ts", "src/lib/theme/themes.ts", "src/lib/theme/tokens.ts", "src/state/theme.ts"]) {
    const source = stripComments(read(file));
    for (const forbidden of ["supabase", "rpc(", "tenant", "branch", "permission", "@/lib/pos/"]) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not mention ${forbidden}`);
    }
  }
});

test("the themes screen writes no business state", () => {
  const source = stripJsxComments(read("src/screens/settings/Themes.tsx"));
  for (const forbidden of ["supabase", "rpc(", "pos_", "loadMenu", "@/lib/pos/"]) {
    assert.ok(!source.includes(forbidden), `Themes.tsx must not reference ${forbidden}`);
  }
});

test("the live POS preview cannot take an order", () => {
  const source = stripJsxComments(read("src/components/theme/PosThemePreview.tsx"));
  // No handlers at all: every control in the preview is a div, so there is
  // nothing to click even by accident.
  for (const forbidden of ["onClick", "onSubmit", "onChange", "<button", "supabase", "@/lib/pos/", "@/state/"]) {
    assert.ok(!source.includes(forbidden), `the preview must not contain ${forbidden}`);
  }
});

test("the preview shows the parts of the POS an operator has to be able to read", () => {
  const source = read("src/components/theme/PosThemePreview.tsx");
  for (const expected of ["Takeaway", "Dine-in", "Delivery", "Current Order", "Send to Kitchen", "Pay", "Clear Cart", "Total"]) {
    assert.ok(source.includes(expected), `the preview must show ${expected}`);
  }
});

// --- two, it is local --------------------------------------------------------

test("a stored choice is read back, and anything unrecognised falls back to the default", () => {
  assert.equal(readStoredThemeId(memoryStorage({ [THEME_STORAGE_KEY]: "black-ember" })), "black-ember");
  for (const bad of ["", "not-a-theme", "CLASSIC-GREEN", "{}", "null"]) {
    assert.equal(
      readStoredThemeId(memoryStorage({ [THEME_STORAGE_KEY]: bad })),
      DEFAULT_THEME_ID,
      `${JSON.stringify(bad)} must not activate a theme`,
    );
  }
  assert.equal(readStoredThemeId(memoryStorage()), DEFAULT_THEME_ID);
});

test("storing a choice writes exactly one namespaced key", () => {
  const store = memoryStorage();
  storeThemeId("coffee-house", store);
  assert.deepEqual(store.read(), { [THEME_STORAGE_KEY]: "coffee-house" });
  assert.ok(THEME_STORAGE_KEY.startsWith("breadee.desktop."), "the key must be namespaced");
});

test("reading a preference never throws, whatever storage does", () => {
  const hostile = {
    getItem: () => {
      throw new Error("storage disabled");
    },
  };
  assert.equal(readStoredThemeId(hostile), DEFAULT_THEME_ID);
  // And writing must not either - a terminal with no storage still has to sell.
  assert.doesNotThrow(() =>
    storeThemeId("black-ember", {
      setItem: () => {
        throw new Error("storage disabled");
      },
    }),
  );
});

test("themeStyle produces only custom properties plus color-scheme", () => {
  // This is what scopes a PREVIEW to a subtree. A rule that leaked anything
  // else would let hovering a theme card restyle the screen around it.
  const style = themeStyle(THEMES["black-ember"]);
  const keys = Object.keys(style);
  const nonVars = keys.filter((k) => !k.startsWith("--c-"));
  assert.deepEqual(nonVars, ["colorScheme"]);
  assert.equal(keys.length, ALL_TOKENS.length + 1);
});

// --- three, it stays readable ------------------------------------------------

test("every theme keeps body text legible on every surface it is drawn on", () => {
  // 4.5:1 is WCAG AA for body text. These are the pairings the app actually
  // renders: ink on the canvas, ink on a card, ink on the quiet fills.
  for (const theme of THEME_LIST) {
    const c = theme.colors;
    for (const [name, bg] of [
      ["canvas", c.canvas],
      ["surface", c.surface],
      ["surfaceMuted", c.surfaceMuted],
      ["surfaceSubtle", c.surfaceSubtle],
    ] as const) {
      const ratio = contrastRatio(c.ink, bg);
      assert.ok(ratio >= 4.5, `${theme.id}: ink on ${name} is ${ratio.toFixed(2)}:1`);
    }
    // Secondary text is smaller but still has to be read at a till.
    const sub = contrastRatio(c.sub, c.surface);
    assert.ok(sub >= 4.5, `${theme.id}: sub on surface is ${sub.toFixed(2)}:1`);
  }
});

test("every theme keeps the brand pairings legible", () => {
  for (const theme of THEME_LIST) {
    const c = theme.colors;
    // A primary button: `text-onbrand` on `bg-brand`.
    //
    // 3:1, NOT 4.5:1, AND THE NUMBER IS DELIBERATE. Button labels here are
    // semibold at 14-16px, which is WCAG's "large text" threshold, and 3:1 is
    // also the AA floor for a UI component. It is also the ratio the product
    // already ships: white on Breadee green (#16a34a) is 3.30:1, and Classic
    // Green must reproduce the existing appearance exactly - raising the bar
    // here would mean an update silently restyled every primary button on
    // every existing terminal. New themes are held to the same line.
    const onBrand = contrastRatio(c.onBrand, c.brand);
    assert.ok(onBrand >= 3, `${theme.id}: onBrand on brand is ${onBrand.toFixed(2)}:1`);
    // A soft badge and the outline button: `text-brand-dark` on `bg-brand-soft`.
    const softPair = contrastRatio(c.brandDark, c.brandSoft);
    assert.ok(softPair >= 4.5, `${theme.id}: brandDark on brandSoft is ${softPair.toFixed(2)}:1`);
    // `text-brand-dark` is also used directly on a card - the price on every
    // menu item is exactly this pairing.
    const priceOnCard = contrastRatio(c.brandDark, c.surface);
    assert.ok(priceOnCard >= 4.5, `${theme.id}: brandDark on surface is ${priceOnCard.toFixed(2)}:1`);
  }
});

test("both status sets keep their notices legible in the direction the app pairs them", () => {
  // The app writes `bg-red-50 text-red-700`, `bg-amber-50 text-amber-900` and
  // `bg-sky-100 text-sky-800`. A dark set that only inverted the fills would
  // pass a naive check and be unreadable in exactly these combinations.
  for (const mode of ["light", "dark"] as const) {
    const s = STATUS_SETS[mode];
    const pairs: [string, string, string][] = [
      ["danger", s.danger700, s.danger50],
      ["danger-800", s.danger800, s.danger50],
      ["warning", s.warning900, s.warning50],
      ["warning-800", s.warning800, s.warning50],
      ["info", s.info800, s.info100],
    ];
    for (const [name, fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      assert.ok(ratio >= 4.5, `${mode} ${name} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the dark theme selects the dark status set, and every light theme the light one", () => {
  for (const theme of THEME_LIST) {
    const vars = themeVariables(theme);
    for (const token of STATUS_TOKENS) {
      assert.equal(vars[token], STATUS_SETS[theme.mode][token], `${theme.id}.${token}`);
    }
  }
  assert.equal(THEMES["black-ember"].mode, "dark");
  assert.equal(THEME_LIST.filter((t) => t.mode === "dark").length, 1);
});

// --- four, an existing installation sees no change ---------------------------

test("Classic Green is the default and reproduces the pre-theme palette exactly", () => {
  assert.equal(DEFAULT_THEME_ID, "classic-green");
  const c = THEMES["classic-green"].colors;
  // The literal values from the tailwind.config.ts and index.css this feature
  // replaced. If any of these move, an existing terminal has been restyled by
  // an update nobody asked for.
  assert.equal(rgbToHex(c.brand), "#16a34a");
  assert.equal(rgbToHex(c.brandDark), "#15803d");
  assert.equal(rgbToHex(c.brandSoft), "#dcfce7");
  assert.equal(rgbToHex(c.ink), "#0f172a");
  assert.equal(rgbToHex(c.sub), "#64748b");
  assert.equal(rgbToHex(c.line), "#e2e8f0");
  assert.equal(rgbToHex(c.canvas), "#f8fafc");
  assert.equal(rgbToHex(c.surface), "#ffffff");
  // The Tailwind slate scale the components were written against.
  assert.equal(rgbToHex(c.surfaceMuted), "#f8fafc");
  assert.equal(rgbToHex(c.surfaceSubtle), "#f1f5f9");
  assert.equal(rgbToHex(c.surfaceStrong), "#e2e8f0");
  assert.equal(rgbToHex(c.neutral300), "#cbd5e1");
  assert.equal(rgbToHex(c.neutral400), "#94a3b8");
  assert.equal(rgbToHex(c.neutral600), "#475569");
  assert.equal(rgbToHex(c.neutral700), "#334155");
});

test("the CSS fallback in index.css matches the Classic Green definition", () => {
  // Two copies of one palette is tolerable only while they cannot drift: the
  // stylesheet is what paints the first frame before any JavaScript runs.
  const css = read("src/index.css");
  const vars = themeVariables(THEMES["classic-green"]);
  for (const token of ALL_TOKENS) {
    const name = cssVarName(token);
    const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
    assert.ok(match, `index.css must declare ${name}`);
    assert.equal(match![1].trim(), vars[token], `index.css ${name} disagrees with THEMES`);
  }
});

test("tailwind maps every token through a CSS variable with an alpha placeholder", () => {
  const config = stripComments(read("tailwind.config.ts"));
  assert.ok(
    config.includes("rgb(var(--c-${name}) / <alpha-value>)"),
    "colours must keep the alpha placeholder or every /opacity modifier breaks",
  );
  // The scales the components actually use must all be redefined, or a class
  // like `bg-slate-50` would render Tailwind's own colour and ignore the theme.
  for (const scale of ["white", "black", "slate", "red", "amber", "sky", "brand", "ink", "sub", "line", "onbrand"]) {
    assert.ok(config.includes(`${scale}:`) || config.includes(`"${scale}"`), `tailwind must redefine ${scale}`);
  }
  // Thermal paper must NOT be themable - see the receipt designer tests.
  assert.ok(config.includes('paper: "#ffffff"'), "receipt paper stays literal white");
  assert.ok(config.includes('"paper-ink": "#000000"'), "receipt ink stays literal black");
});

test("no component hard-codes a colour outside the token layer", () => {
  // A stray hex or an arbitrary `bg-[#...]` would be a spot the theme cannot
  // reach - which is how a "themed" app ends up with one white panel.
  const files = listSources(join(root, "src"));
  for (const file of files) {
    const source = stripJsxComments(readFileSync(file, "utf8"));
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");
    // Three deliberate exceptions, each documented in place: a QR must be black
    // on white to scan, a theme is literally a list of colours, and the
    // customized grid's key palette is a list of colours too.
    //
    // THE GRID PALETTE IS THE ONE ADDED IN 1.0.6, and it is an exception for a
    // stated reason rather than a convenience: a cashier's coloured key is a
    // landmark they hit without reading, like a physical key cap, so it must NOT
    // change when the terminal's theme does. Its INK is computed from the fill
    // by measured contrast, which is what keeps it readable in light and dark -
    // see the WCAG assertion in `pos-custom-grid.test.ts`. An uncoloured key
    // uses theme classes like everything else.
    if (
      rel.startsWith("src/lib/theme/") ||
      rel === "src/components/pos/QrSymbol.tsx" ||
      rel === "src/lib/pos/grid/colors.ts"
    ) {
      continue;
    }
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(source), `${rel} hard-codes a hex colour`);
    assert.ok(!/(bg|text|border)-\[#/.test(source), `${rel} uses an arbitrary colour value`);
  }
});

test("the grid palette exception is bounded - components only ever resolve it", () => {
  // The exception above is only safe while nothing SPREADS it. If a component
  // could write its own hex "just this once", the palette would stop being one
  // list and the readability guarantee - which is computed from that list -
  // would stop covering every button on screen.
  for (const rel of [
    "src/components/pos/grid/GridButtonTile.tsx",
    "src/components/pos/grid/CustomGrid.tsx",
    "src/components/pos/grid/GridDesigner.tsx",
    "src/components/pos/grid/AddButtonWizard.tsx",
    "src/screens/settings/CashierLayout.tsx",
  ]) {
    const source = stripJsxComments(readFileSync(join(root, rel), "utf8"));
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(source), `${rel} must take its colours from the palette, not a literal`);
  }
  // And the layout MODEL stores a token pair, never a colour: a stored hex would
  // freeze a decision that a future palette revision could not reach.
  const model = stripJsxComments(readFileSync(join(root, "src/lib/pos/grid/model.ts"), "utf8"));
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(model), "a layout must store a colour token, never a hex value");
  assert.match(model, /hue: string; shade: number/);
});

test("helpers convert both ways and reject anything that is not a six-digit hex", () => {
  assert.equal(hexToRgb("#16a34a"), "22 163 74");
  assert.equal(rgbToHex("22 163 74"), "#16a34a");
  for (const bad of ["16a34a", "#abc", "#gggggg", "", "rgb(1,2,3)"]) {
    assert.throws(() => hexToRgb(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test("unknown theme ids resolve to the default rather than crashing a till", () => {
  assert.equal(themeById("nope").id, DEFAULT_THEME_ID);
  assert.equal(themeById(null).id, DEFAULT_THEME_ID);
  assert.equal(themeById(undefined).id, DEFAULT_THEME_ID);
  assert.equal(themeById("funky-street").id, "funky-street");
  assert.ok(isThemeId("fresh-garden"));
  assert.ok(!isThemeId("fresh garden"));
});

test("every theme card has five swatches to recognise it by", () => {
  for (const theme of THEME_LIST) assert.equal(swatches(theme).length, 5);
});

/** Every .ts/.tsx under a directory. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith("database.types.ts")) out.push(full);
  }
  return out;
}
