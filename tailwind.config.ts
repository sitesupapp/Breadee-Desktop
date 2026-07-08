import type { Config } from "tailwindcss";

// Mirrors the Breadee web app's brand tokens so ported components look identical.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#16a34a",
          dark: "#15803d",
          soft: "#dcfce7",
        },
        ink: "#0f172a",
        sub: "#64748b",
        line: "#e2e8f0",
      },
    },
  },
  plugins: [],
} satisfies Config;
