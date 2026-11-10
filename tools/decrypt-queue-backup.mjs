#!/usr/bin/env node
// 1.0.41 (F-STORE) — support tool: decrypt a "Back up unsynced work" file from a Breadee Desktop terminal.
//
//   node tools/decrypt-queue-backup.mjs <backup.json> <output.json>
//
// The passphrase is read from the BREADEE_BACKUP_PASSPHRASE environment variable (never a command-line argument,
// so it does not land in shell history). The output holds the terminal's unsynced operations, offline sales and
// table sessions exactly as they were on the device, for review. This tool never contacts Breadee and never
// replays anything: recovery of what it shows is a reviewed, manual decision.

import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const [, , input, output] = process.argv;
const pass = process.env.BREADEE_BACKUP_PASSPHRASE ?? "";
if (!input || !output) {
  console.error("usage: node tools/decrypt-queue-backup.mjs <backup.json> <output.json>  (passphrase in BREADEE_BACKUP_PASSPHRASE)");
  process.exit(2);
}
if (!pass) {
  console.error("Set BREADEE_BACKUP_PASSPHRASE to the passphrase chosen on the terminal.");
  process.exit(2);
}
const env = JSON.parse(readFileSync(input, "utf8"));
if (env.format !== "breadee-queue-backup") {
  console.error("Not a Breadee queue backup.");
  process.exit(1);
}
const unb64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const subtle = webcrypto.subtle;
const base = await subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey(
  { name: "PBKDF2", hash: "SHA-256", salt: unb64(env.kdf.salt), iterations: env.kdf.iterations },
  base,
  { name: "AES-GCM", length: 256 },
  false,
  ["decrypt"],
);
let plain;
try {
  plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.cipher.iv) }, key, unb64(env.data));
} catch {
  console.error("Wrong passphrase, or the file was changed.");
  process.exit(1);
}
writeFileSync(output, JSON.stringify(JSON.parse(new TextDecoder().decode(plain)), null, 2));
console.log(`Decrypted ${env.summary.operations} operations, ${env.summary.capture_rows} offline sales, ${env.summary.sessions} sessions → ${output}`);
