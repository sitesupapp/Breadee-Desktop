// 1.0.37 cumulative release: the 1.0.36 R5 operational-branch fix (ec0f7cb + c655651) must survive the
// merge with the Full Offline line UNCHANGED. These are source contracts on the release candidate, one
// per R5 behaviour, so a future merge that drops any of them fails here instead of on a till.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const posState = readFileSync(new URL("../src/state/pos.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/screens/pos/PosWorkspace.tsx", import.meta.url), "utf8");

test("R5 PostgREST { error } handling: the active-branch list is KNOWN only when the query returned no error", () => {
  assert.match(posState, /const \{ data, error \} = await supabase\.from\("branches"\)\.select\("id, name"\)\.eq\("tenant_id", tenantId\)\.eq\("status", "active"\)/);
  // Offline-first recovery: a KNOWN list is also cached for the offline branch picker (only then).
  assert.match(posState, /if \(!error\) \{\s*activeBranches = [^\n]+\n\s*branchesKnown = true;\s*cacheActiveBranches\(tenantId, activeBranches\);\s*\}/);
});

test("R5 offline last-good pin: an unknown branch list trusts the persisted pin as-is (never falls back to Main)", () => {
  assert.match(posState, /if \(!branchesKnown\) \{\s*effectiveSelected = selectedBranch;/);
});

test("R5 inactive persisted pin repair: an inactive pin falls to own open shift (if active) → Main (if active) → first active, and the store is rewritten", () => {
  assert.match(posState, /\} else if \(isActiveBranch\(selectedBranch\)\) \{\s*effectiveSelected = selectedBranch;/);
  assert.match(posState, /if \(sh\?\.branch_id && isActiveBranch\(sh\.branch_id\)\) effectiveSelected = sh\.branch_id;/);
  assert.match(posState, /effectiveSelected = isActiveBranch\(mainId\) \? mainId : \(activeBranches\[0\]\?\.id \?\? null\);/);
  assert.match(posState, /if \(effectiveSelected && effectiveSelected !== selectedBranch && tenantId && userId\) \{\s*setBranchInStore\(tenantId, userId, effectiveSelected\);/);
  assert.match(posState, /setBranchOptions\(allBranches \? activeBranches : \[\]\);/);
});

test("R5 genuine branch switch clears an UNSENT cart, never on the initial resolution", () => {
  assert.match(workspace, /const prevOperationalBranchRef = useRef<string \| null>\(null\);/);
  assert.match(workspace, /const prev = prevOperationalBranchRef\.current;\s*const next = pos\.branch\.id;\s*prevOperationalBranchRef\.current = next;/);
  assert.match(workspace, /if \(prev && next && prev !== next && !useCart\.getState\(\)\.savedOrder\) \{\s*newOrder\(\);\s*\}/);
  assert.match(workspace, /\}, \[pos\.branch\.id, newOrder\]\);/);
});

test("R5 a server-ACCEPTED unpaid order is preserved across a branch switch (savedOrder guard is the only clear path)", () => {
  // The only newOrder() inside the branch-switch effect is behind !savedOrder.
  const effect = workspace.slice(workspace.indexOf("const prevOperationalBranchRef"), workspace.indexOf("}, [pos.branch.id, newOrder]);"));
  assert.equal((effect.match(/newOrder\(\)/g) ?? []).length, 1);
  assert.match(effect, /!useCart\.getState\(\)\.savedOrder\) \{\s*newOrder\(\);/);
});
