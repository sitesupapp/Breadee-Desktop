// Back-compat shim. The dual USD/LBP display helpers now live in `@/lib/currency`.
// Kept so existing imports (`@/lib/money`) keep working with identical behavior;
// prefer importing from `@/lib/currency` in new code.
export { formatMoney, type CurrencyCode } from "@/lib/currency";
