// Who is standing at the terminal.
//
// The status bar names the operator, so it needs the profile's display name, not
// the login email. Mirrors the web POS, which prints `full_name ?? email` on the
// receipt as the serving staff member.

import { supabase } from "@/lib/supabase";

export async function loadOperatorName(userId: string | null, fallbackEmail: string | null): Promise<string> {
  const fallback = fallbackEmail?.trim() || "Cashier";
  if (!userId) return fallback;
  const { data, error } = await supabase.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
  if (error || !data) return fallback;
  const name = typeof data.full_name === "string" ? data.full_name.trim() : "";
  if (name) return name;
  const email = typeof data.email === "string" ? data.email.trim() : "";
  return email || fallback;
}
