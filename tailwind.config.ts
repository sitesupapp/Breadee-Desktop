import type { Config } from "tailwindcss";

// THE THEME LAYER LIVES HERE, NOT IN THE COMPONENTS.
//
// Every colour the desktop app uses is declared once, as
// `rgb(var(--c-…) / <alpha-value>)`. `src/lib/theme/*` then supplies those
// variables. The consequence is that a theme reaches the whole application -
// Dashboard, POS, Takeaway, Dine-in, Delivery, Orders, Profile, Settings,
// modals, drawers, forms, tables, cards, tabs, inputs, switches, category
// buttons, item cards, Current Order, payment, shift, printers, the receipt
// designer - without a single component knowing that themes exist.
//
// WHY THE RAW PALETTE NAMES ARE REDEFINED. The codebase already used
// `bg-white`, `bg-slate-50`, `text-red-700`, `bg-amber-50`, `text-sky-800` and
// so on in ~320 places. Renaming all of them to semantic classes would have
// been a 320-site refactor of working POS screens for no functional gain, and
// every missed site would have been a hard-coded colour that ignored the theme.
// Redefining the SCALES instead makes the existing classes themeable where they
// stand, and keeps their meaning: `slate` is neutral surface, `red` is danger,
// `amber` is warning, `sky` is information. Only the shades actually used are
// declared, so an unused one fails the build instead of silently rendering an
// off-theme colour.
//
// `<alpha-value>` is what keeps `bg-brand/40`, `text-sub/70` and
// `bg-slate-200/70` working, and is why the variables hold space-separated
// channels rather than hex.
const themed = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: themed("brand"),
          dark: themed("brand-dark"),
          soft: themed("brand-soft"),
        },
        ink: themed("ink"),
        sub: themed("sub"),
        line: themed("line"),
        canvas: themed("canvas"),
        /** Text/glyphs drawn on a brand or danger fill. */
        onbrand: themed("on-brand"),

        white: themed("surface"),
        black: themed("black"),

        // Neutral surfaces and secondary text.
        slate: {
          50: themed("surface-muted"),
          100: themed("surface-subtle"),
          200: themed("surface-strong"),
          300: themed("neutral-300"),
          400: themed("neutral-400"),
          600: themed("neutral-600"),
          700: themed("neutral-700"),
        },

        // Danger. Low indices are fills, high indices are text - a dark theme
        // swaps the VALUES and keeps that relationship (see themes.ts).
        red: {
          50: themed("danger-50"),
          100: themed("danger-100"),
          200: themed("danger-200"),
          300: themed("danger-300"),
          500: themed("danger-500"),
          600: themed("danger-600"),
          700: themed("danger-700"),
          800: themed("danger-800"),
          900: themed("danger-900"),
        },

        // Warning.
        amber: {
          50: themed("warning-50"),
          100: themed("warning-100"),
          200: themed("warning-200"),
          300: themed("warning-300"),
          400: themed("warning-400"),
          500: themed("warning-500"),
          600: themed("warning-600"),
          700: themed("warning-700"),
          800: themed("warning-800"),
          900: themed("warning-900"),
        },

        // Information.
        sky: {
          50: themed("info-50"),
          100: themed("info-100"),
          200: themed("info-200"),
          500: themed("info-500"),
          800: themed("info-800"),
        },

        /**
         * THERMAL PAPER, DELIBERATELY NOT THEMED.
         *
         * The receipt and kitchen-ticket previews exist to predict what comes
         * out of an 80mm thermal printer, and that is black ink on white paper
         * whatever the terminal's theme is. Themed previews would show a
         * cashier a burgundy receipt and print a black one - a preview of a
         * different document. These two are literal values with no variable
         * behind them, which is what makes that impossible.
         */
        paper: "#ffffff",
        "paper-ink": "#000000",
        "paper-sub": "#4b4b4b",
        "paper-line": "#c8c8c8",
      },
    },
  },
  plugins: [],
} satisfies Config;
