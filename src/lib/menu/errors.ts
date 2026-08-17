// Menu Builder refusal -> operator-facing message.
//
// The rule this file exists to keep: the UI never pretends a save succeeded, and
// it never shows the operator a raw fault. Postgres/PostgREST failures arrive
// with codes and, in the RLS case, with a message that means nothing to a
// restaurant manager ("new row violates row-level security policy for table
// \"menu_items\""). Those are translated. Messages the SERVER deliberately wrote
// for a human - `_price_write_prepare`'s "Price cannot be negative", m138's
// permission wording, `_assert_menu_price_writer`'s branch refusals - are passed
// through UNCHANGED, because they are already better than anything written here.
//
// Nothing in this module ever surfaces a SQL statement, a policy name, a stack,
// a token or a URL: `detailFor` returns only the server's own sentence, and only
// when that sentence was written for a human.

export type MenuFailure = {
  /** One short sentence naming what did not happen. */
  message: string;
  /** The server's own explanation, when it is fit to show. */
  detail: string | null;
};

type SupabaseLikeError = { message?: unknown; code?: unknown; details?: unknown };

const text = (e: unknown): string => {
  if (!e) return "";
  if (typeof e === "string") return e;
  const m = (e as SupabaseLikeError).message;
  return typeof m === "string" ? m : "";
};

const code = (e: unknown): string => {
  const c = (e as SupabaseLikeError)?.code;
  return typeof c === "string" ? c : "";
};

/**
 * True when a server message was written to be read by a person.
 *
 * The whitelist is deliberate. An RLS violation, a constraint name and a
 * connection fault are all "messages" too, and none of them should reach an
 * operator; they are replaced by `message` instead.
 */
function isHumanMessage(raw: string): boolean {
  if (raw === "") return false;
  if (/row-level security|violates|constraint|duplicate key|syntax error|relation "|column "/i.test(raw)) return false;
  if (/JWT|jwt|token|Bearer|apikey/i.test(raw)) return false;
  return true;
}

/** Classify a failed Menu Builder operation. `action` names what was attempted. */
export function menuFailure(error: unknown, action: string): MenuFailure {
  const raw = text(error);
  const c = code(error);

  // Offline / transport. `fetch` rejects with a TypeError carrying this text.
  if (/failed to fetch|networkerror|network request failed/i.test(raw)) {
    return { message: `${action} failed because this terminal is offline.`, detail: "Reconnect and try again." };
  }

  // RLS refusal. Postgres reports 42501, PostgREST surfaces it as 42501 or as
  // the "new row violates row-level security policy" text on an INSERT.
  if (c === "42501" || /row-level security/i.test(raw)) {
    return {
      message: `${action} was refused.`,
      detail: "Your account does not have permission for this change, or your plan does not include it.",
    };
  }

  // Feature gate. `assert_feature_access` raises its own readable sentence.
  if (/not (available|included|enabled)/i.test(raw) && isHumanMessage(raw)) {
    return { message: `${action} was refused.`, detail: raw };
  }

  if (isHumanMessage(raw)) return { message: `${action} failed.`, detail: raw };
  return { message: `${action} failed.`, detail: "Please try again. If it keeps failing, contact support." };
}
