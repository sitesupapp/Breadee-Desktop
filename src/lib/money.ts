// Lightweight money formatting for the desktop foundation.
// TODO(desktop): port the web app's full dual-currency helpers (src/lib/currency.ts:
// formatMoney / getEquivalentAmount / hasValidRate) once the currency settings RPC
// wiring is added, so USD + LBP dual display matches the web app exactly.
export function formatMoney(amount: number | null | undefined, code = "USD"): string {
  const n = Number(amount ?? 0);
  if (code === "LBP") return `${Math.round(n).toLocaleString()} LBP`;
  return `$${n.toFixed(2)}`;
}
