// The native shell's single-instance guard, and the dashboard copy that
// describes what the desktop actually ships.
//
// WHY THIS FILE EXISTS
// Packaged QA on 2026-08-08 launched the installed app three times and got
// three concurrent processes. Nobody was double-charged - the server refuses a
// second settlement on an already-paid table - but each process had its own
// cart, its own selected table and its own in-memory payment latch. Two tills
// on one terminal is an operational hazard: the cashier can build an order in
// one window and settle in another, and the window that took the money is not
// necessarily the one they are looking at.
//
// The Rust shell is not reachable from the Node test runner, so this asserts
// the source the way `pos-touch-targets` and `pos-dine-in-actions` do. That is
// the right instrument here: every regression this guards IS source-level - a
// dropped plugin registration, a callback that grows a side effect, or a
// dependency quietly scoped out of the Windows build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments } from "./source-helpers.ts";
import { MODULES } from "@/lib/modules";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

/** Rust line comments use the same `//` form, so the shared stripper applies. */
const rustCode = () => stripComments(read("src-tauri", "src", "lib.rs"));

// --- the dependency ----------------------------------------------------------

test("the single-instance plugin is a declared dependency", () => {
  const cargo = read("src-tauri", "Cargo.toml");
  assert.match(cargo, /tauri-plugin-single-instance\s*=\s*"2"/, "the single-instance plugin is not depended on");
});

test("the plugin is scoped to desktop targets, not added to the shared list", () => {
  // It does not exist for mobile; putting it in `[dependencies]` would break a
  // mobile build rather than merely be unused.
  const cargo = read("src-tauri", "Cargo.toml");
  // NB the cfg predicate nests parentheses - `cfg(any(target_os = "windows", …))`
  // - so the header cannot be matched with `[^)]*`, which stops at the first
  // inner `)`. Match to the closing `'.dependencies]` instead.
  const target = /\[target\.'(cfg\(.*\))'\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(cargo);
  assert.ok(target, "no target-scoped dependency block was found");
  assert.match(target[2], /tauri-plugin-single-instance/, "the plugin is not inside the desktop-scoped block");
  for (const os of ["windows", "macos", "linux"]) {
    assert.match(target[1], new RegExp(os), `the desktop scope omits ${os}`);
  }
  // And it must NOT also sit in the shared list, where a mobile build would try
  // to resolve it.
  const shared = /\n\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(cargo);
  assert.ok(shared, "the shared [dependencies] block could not be located");
  assert.doesNotMatch(shared[1], /tauri-plugin-single-instance/, "the plugin is also in the shared dependency list");
});

test("the lockfile pins the plugin, so cargo check --locked can pass in CI", () => {
  const lock = read("src-tauri", "Cargo.lock");
  assert.match(lock, /name = "tauri-plugin-single-instance"/, "Cargo.lock was not updated for the new dependency");
});

// --- the registration --------------------------------------------------------

test("the plugin is registered, and registered FIRST", () => {
  const code = rustCode();
  assert.match(code, /tauri_plugin_single_instance::init\(/, "the single-instance plugin is not registered");
  const single = code.indexOf("tauri_plugin_single_instance::init");
  const opener = code.indexOf("tauri_plugin_opener::init");
  assert.ok(single > 0 && opener > 0, "plugin registrations could not be located");
  assert.ok(single < opener, "single-instance must be registered before other plugins - it has to claim the lock first");
});

test("registration is compiled for desktop only", () => {
  const code = rustCode();
  assert.match(code, /#\[cfg\(desktop\)\]\s*\n\s*let builder = builder\.plugin\(tauri_plugin_single_instance::init\(/);
});

// --- the callback ------------------------------------------------------------

test("the callback focuses the EXISTING main window", () => {
  const code = rustCode();
  const fn = /fn focus_existing_window[\s\S]*?\n\}/.exec(code)?.[0] ?? "";
  assert.notEqual(fn, "", "focus_existing_window could not be located");
  assert.match(fn, /get_webview_window\("main"\)/, "the callback does not target the declared main window");
  assert.match(fn, /unminimize\(\)/, "a minimised window would stay minimised");
  assert.match(fn, /set_focus\(\)/, "the window is never focused");
});

test("the callback never creates a second window", () => {
  const code = rustCode();
  for (const forbidden of ["WebviewWindowBuilder", "WindowBuilder", "::new(", "add_window"]) {
    assert.equal(code.includes(forbidden), false, `the shell can construct a window (${forbidden})`);
  }
});

test("the callback has no side effect beyond focus", () => {
  // The running instance may be mid-order or mid-payment. Navigating,
  // reloading or emitting into it would destroy work the cashier has already
  // read out to a table.
  const fn = /fn focus_existing_window[\s\S]*?\n\}/.exec(rustCode())?.[0] ?? "";
  for (const forbidden of ["navigate", "eval(", "emit(", "reload", "exit(", "restart"]) {
    assert.equal(fn.includes(forbidden), false, `the single-instance callback performs "${forbidden}"`);
  }
});

test("the second process's launch arguments are ignored", () => {
  // The app has no deep-link or file-open handling, so argv carries nothing to
  // act on - and acting on it would be a way to drive the POS from outside it.
  const code = rustCode();
  assert.match(code, /\|app, _argv, _cwd\|/, "the callback binds argv/cwd as used parameters");
});

test("the existing instance is never terminated to make room", () => {
  const code = rustCode();
  assert.doesNotMatch(code, /std::process::exit|app\.exit\(|kill/, "the shell force-exits a process");
});

// --- dashboard copy ----------------------------------------------------------

test("the POS module no longer defers Dine-in", () => {
  const pos = MODULES.find((m) => m.key === "pos");
  assert.ok(pos, "the POS module entry disappeared");
  assert.doesNotMatch(pos!.desc, /dine-?in[^.]*coming next/i, "the dashboard still says Dine-in is coming");
  assert.doesNotMatch(pos!.desc, /coming next/i, "the dashboard still defers a shipped capability");
  assert.match(pos!.desc, /dine-?in/i, "the dashboard no longer mentions Dine-in at all");
});

// RETARGETED BY LEVEL 3D. This required Delivery to be named only as something
// NOT here - correct while the route was customers-only, and false since 3B
// added ordering and 3C added settlement. Leaving it would have kept the test
// defending a claim the app had already outgrown, which is how this copy came to
// be wrong twice. The enduring property is narrower: the tile must not promise a
// capability the desktop does not have, and the only one left is PRINTING.
test("the dashboard names Delivery, and still does not claim printing exists", () => {
  const pos = MODULES.find((m) => m.key === "pos")!;
  assert.match(pos.desc, /delivery/i, "Delivery is a shipped order type and should be named");
  // The retired deferral is gone rather than merely unasserted.
  assert.doesNotMatch(pos.desc, /delivery[^.]*(not available|not yet)/i);
  // Printing is the one thing still deferred, and it must say so.
  assert.match(pos.desc, /printing is not available/i);
  assert.doesNotMatch(pos.desc, /printing[^.]*(available now|supported|enabled)/i);
});

test("the POS module still points at the real route and keeps its own gate", () => {
  const pos = MODULES.find((m) => m.key === "pos")!;
  assert.equal(pos.availability, "desktop");
  assert.equal(pos.to, "/pos");
  assert.equal(typeof pos.show, "function");
});

// RETARGETED BY LEVEL 3A. This asserted `enabled: false` while Delivery did not
// exist, which was the right guard then. Level 3A ships the Delivery customer
// foundation, so the invariant it protected - the route is never hard-enabled -
// is now expressed as "enabled by a gate", not "enabled by a literal". Relaxing
// it to nothing would have left the rail unguarded; this was left failing until
// the route genuinely landed.
test("the Delivery route is enabled by a gate, never by a literal", () => {
  const workspace = read("src", "screens", "pos", "PosWorkspace.tsx");
  assert.doesNotMatch(workspace, /key: "delivery",[^}]*enabled: true/, "the Delivery route was hard-enabled");
  assert.match(workspace, /key: "delivery",[^}]*enabled: deliveryGate\.allowed/, "the Delivery route lost its gate");
});
