// 1.0.38 PERF (Track 8) — static network guard (cheap; catches regressions the sentinel cannot reach
// because screens/components are .tsx and do not run under Node).
//
// The network primitives (foundation_discovery_perf §1.0): the Supabase client module, the
// supabase-js package, raw fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon, and the
// Tauri http / updater plugins. UI code (screens/**, components/**) must reach the backend only through
// lib/ boundaries that own their offline story — never through a primitive — except the explicit
// allow-list below (online-only by design, gated). A new direct use fails here and must either move
// into lib/ or be added to the allow-list with a reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** Each primitive, as a pattern over comment-stripped source. */
const PRIMITIVES: { id: string; re: RegExp }[] = [
  { id: "supabase-client", re: /["']@\/lib\/supabase["']/ },
  { id: "supabase-js", re: /["']@supabase\/supabase-js["']/ },
  { id: "raw-fetch", re: /(?<![.\w])fetch\s*\(/ },
  { id: "xhr", re: /\bXMLHttpRequest\b/ },
  { id: "websocket", re: /\bnew\s+WebSocket\b/ },
  { id: "event-source", re: /\bEventSource\b/ },
  { id: "beacon", re: /\bsendBeacon\b/ },
  { id: "tauri-http", re: /["']@tauri-apps\/plugin-http["']/ },
  { id: "tauri-updater", re: /["']@tauri-apps\/plugin-updater["']/ },
];

/** UI files allowed a primitive, and why. Keep this short. */
const UI_ALLOW: Record<string, string[]> = {
  // Online-only analytics screen (gated by its own view gate; never on a POS sale path). Its `fetch(...)`
  // is a LOCAL function name, but the lazy client import is real.
  "src/screens/Analytics.tsx": ["supabase-client", "raw-fetch"],
};

test("screens/** and components/** use no network primitive outside the allow-list", () => {
  const files = [...walk(join(root, "src", "screens")), ...walk(join(root, "src", "components"))];
  assert.ok(files.length > 50, "the walk must actually cover the UI tree");
  const violations: string[] = [];
  for (const f of files) {
    const code = src(f);
    for (const p of PRIMITIVES) {
      if (p.re.test(code) && !(UI_ALLOW[f] ?? []).includes(p.id)) violations.push(`${f}: ${p.id}`);
    }
  }
  assert.deepEqual(violations, [], "new direct network use in UI code — route it through lib/ or allow-list it with a reason");
});

test("the allow-list is not stale (every entry still needs its exception)", () => {
  for (const [f, ids] of Object.entries(UI_ALLOW)) {
    const code = src(f);
    for (const id of ids) {
      const p = PRIMITIVES.find((x) => x.id === id);
      assert.ok(p && p.re.test(code), `${f} no longer uses ${id}: drop it from UI_ALLOW`);
    }
  }
});

test("lib boundary: supabase-js is created ONCE (lib/supabase.ts), with the timeout transport", () => {
  const files = walk(join(root, "src"));
  const creators = files.filter((f) => /["']@supabase\/supabase-js["']/.test(src(f)));
  assert.deepEqual(creators, ["src/lib/supabase.ts"]);
  const client = src("src/lib/supabase.ts");
  assert.match(client, /fetch: timeoutFetch/, "the client's global.fetch is the bounded transport");
  assert.match(client, /import \{ timeoutFetch \} from "@\/lib\/net\/timeoutFetch"/);
  // The raw probe stays the ONLY raw fetch default (its `fetch` is the deps fallback, not a call site).
  const raw = files.filter((f) => /(?<![.\w])fetch\s*\(/.test(src(f)) && !f.startsWith("src/screens/") && !f.startsWith("src/components/"));
  assert.deepEqual(raw, [], "no raw fetch call in lib/state (the probe and timeoutFetch call an injected `f`)");
});

test("print routing in POS UI / print helpers goes through the cache-backed lookup (C1–C3)", () => {
  for (const f of ["src/screens/pos/ReceiptPreview.tsx", "src/screens/pos/PosWorkspace.tsx", "src/lib/pos/collectionTicket.ts", "src/lib/pos/receivableReceipt.ts"]) {
    const code = src(f);
    assert.match(code, /resolvePrintRouteCached\(/, `${f} uses the cache-backed lookup`);
    assert.doesNotMatch(code, /resolvePrintRoute\(/, `${f} must not call the uncached resolver`);
  }
  // The only remaining direct callers own their cache (autoPrintRun, KitchenTicketPreview) or are
  // online admin screens (Print Test Center, Receipt Design).
  const direct = walk(join(root, "src")).filter((f) => /resolvePrintRoute\(/.test(src(f)) && f !== "src/lib/pos/printRouteResolver.ts");
  assert.deepEqual(direct.sort(), [
    "src/lib/pos/autoPrintRun.ts",
    "src/screens/pos/KitchenTicketPreview.tsx",
    "src/screens/settings/PrintTestCenter.tsx",
    "src/screens/settings/ReceiptDesign.tsx",
  ]);
});

test("R1: every Dine-In server path re-checks the shared reachability store first", () => {
  const dw = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(dw, /const serverPathLost = useCallback\(async \(\): Promise<string \| null> => \{\s*if \(await isBackendReachable\(\)\.catch\(\(\) => false\)\) return null;/);
  // open, round, move, merge, split (open + pay), quantity edit, modifier edit, table pay, on account.
  assert.equal((dw.match(/await serverPathLost\(\)/g) ?? []).length, 10);
  for (const call of ["moveTable(", "mergeTables(", "openTable(", "performRound(", "settleSplit(", "loadSplitState(order.id)", "performTablePayment(", "performOnAccount("]) {
    const at = dw.indexOf(call);
    const guard = dw.lastIndexOf("await serverPathLost()", at);
    assert.ok(at > 0 && guard > 0 && at - guard < 2500, `${call} is preceded by the re-check`);
  }
  const pw = src("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /subscribeReachability\(\(r\) => \{\s*if \(live\) setBackendReachable\(r\);/, "the badge poll feeds/reads the shared store");
});

test("Delivery C5–C8 + POS boot C9 + reprint C4 are gated (source)", () => {
  const dl = src("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dl, /const \[server, shifts\] = offline\s*\?/, "C5: party/shift reads skipped on an offline queue");
  assert.match(dl, /if \(!online \|\| lastKnownReachable\(\) === false\) \{\s*setOpenOrders\(\[\]\);/, "C6");
  assert.match(dl, /if \(!online\) void fromMirror\(\);/, "C7: provider mirror offline");
  const byId = dl.slice(dl.indexOf("const openHistoricalReceiptById"), dl.indexOf("// F4 OPENS"));
  assert.ok(byId.indexOf("if (!online)") >= 0 && byId.indexOf("if (!online)") < byId.indexOf("readDeliveryOrder("), "C8: offline before the read by id");
  const pos = src("src/state/pos.ts");
  assert.match(pos, /const reachable = await isBackendReachable\(\)\.catch\(\(\) => false\);\s*if \(allBranches && tenantId && reachable\)/, "C9");
  assert.match(pos, /raceBootRead\(branchP, POS_BOOT_READ_TIMEOUT_MS\)/);
  const pw = src("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /if \(lastKnownReachable\(\) === false && \(await presentSnapshot\(\)\)\) return;/, "C4: offline-first reprint");
});
