// 1.0.41 (Server Off F-STORE) — the device-side durability of offline work.
//
// While Breadee's server is off, this terminal's IndexedDB (WebView2 profile) IS the only copy of every captured
// sale, payment and shift event. Through 1.0.40 nothing asked the browser to keep it (best-effort storage may be
// evicted under disk pressure), a full disk surfaced as an unexplained error, and there was no way to take the
// queue off a failing machine. This module:
//   - asks for PERSISTENT storage once per run (navigator.storage.persist) and reports the outcome;
//   - reads usage / quota and flags low space before it becomes a failed write;
//   - recognises a storage-full write failure, so the cashier is told plainly that it was NOT saved
//     (and must not collect for it) instead of a generic error;
//   - checks that the local store opens and its operation log reads (integrity), without writing anything;
//   - exports an ENCRYPTED backup of the unsynced queue (passphrase → PBKDF2-SHA-256 → AES-GCM-256) that support can
//     decrypt with tools/decrypt-queue-backup.mjs. The export never changes, acknowledges or deletes anything.
//
// Nothing here writes to the operation log.

export const LOW_SPACE_BYTES = 200 * 1024 * 1024;
export const LOW_SPACE_RATIO = 0.9;

export const STORAGE_FULL_MESSAGE =
  "This terminal's storage is full, so this was NOT saved. Do not collect payment for it. Free disk space on this computer (or call a manager), then try again — everything saved before stays safe.";

export type StorageStatus = {
  /** true = the browser will not evict this terminal's data under pressure; null = unknown / unsupported. */
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  lowSpace: boolean;
};

type StorageManagerLike = {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
};

function storageManager(): StorageManagerLike | null {
  try {
    const n = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator;
    return n?.storage ?? null;
  } catch {
    return null;
  }
}

let persistAsked: Promise<boolean | null> | null = null;

/** Ask once per run for persistent storage. Never throws. */
export function requestPersistentStorage(sm: StorageManagerLike | null = storageManager()): Promise<boolean | null> {
  if (persistAsked) return persistAsked;
  persistAsked = (async () => {
    if (!sm) return null;
    try {
      if (typeof sm.persisted === "function" && (await sm.persisted())) return true;
      if (typeof sm.persist === "function") return await sm.persist();
    } catch {
      /* unsupported / refused */
    }
    return null;
  })();
  return persistAsked;
}

/** PURE — low space: less than LOW_SPACE_BYTES left, or more than LOW_SPACE_RATIO of the quota used. */
export function isLowSpace(usage: number | null, quota: number | null): boolean {
  if (usage == null || quota == null || !(quota > 0)) return false;
  return quota - usage < LOW_SPACE_BYTES || usage / quota > LOW_SPACE_RATIO;
}

export async function storageStatus(sm: StorageManagerLike | null = storageManager()): Promise<StorageStatus> {
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (sm && typeof sm.persisted === "function") persisted = await sm.persisted();
  } catch {
    persisted = null;
  }
  try {
    if (sm && typeof sm.estimate === "function") {
      const e = await sm.estimate();
      usage = typeof e.usage === "number" ? e.usage : null;
      quota = typeof e.quota === "number" ? e.quota : null;
    }
  } catch {
    /* unknown */
  }
  return { persisted, usageBytes: usage, quotaBytes: quota, lowSpace: isLowSpace(usage, quota) };
}

/** PURE — is this a storage-full write failure (IndexedDB / Dexie QuotaExceededError, a full disk)? */
export function isStorageFullError(e: unknown): boolean {
  if (!e || (typeof e !== "object" && typeof e !== "string")) return false;
  const name = typeof e === "object" ? String((e as { name?: unknown }).name ?? "") : "";
  const inner = typeof e === "object" ? (e as { inner?: { name?: unknown } }).inner : undefined;
  if (name === "QuotaExceededError" || String(inner?.name ?? "") === "QuotaExceededError") return true;
  const msg = typeof e === "string" ? e : String((e as { message?: unknown }).message ?? "");
  return /QuotaExceeded|quota (?:has been )?exceeded|disk is full|not enough (?:disk )?space|no space left|ENOSPC/i.test(msg);
}

export type IntegrityResult = { ok: true; operations: number } | { ok: false; detail: string };

/** Read-only integrity check: the local store opens and the operation log can be counted and read. */
export async function checkLocalStoreIntegrity(): Promise<IntegrityResult> {
  try {
    const { localdb } = await import("@/lib/offline/db");
    const n = await localdb.operations.count();
    await localdb.operations.limit(1).toArray();
    return { ok: true, operations: n };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

// --- encrypted queue backup ---------------------------------------------------------------

export const BACKUP_FORMAT = "breadee-queue-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_KDF_ITERATIONS = 250_000;
export const BACKUP_MIN_PASSPHRASE = 10;

export type QueueBackupEnvelope = {
  format: typeof BACKUP_FORMAT;
  v: number;
  created_at: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  /** Counts only (no content), so a reader can see what the file holds without the passphrase. */
  summary: { operations: number; capture_rows: number; sessions: number };
  data: string;
};

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

function cryptoApi(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error("Encryption is not available on this device.");
  return c;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const c = cryptoApi();
  const base = await c.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return c.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt any JSON-serialisable content into a backup envelope. */
export async function encryptBackup(content: unknown, passphrase: string, summary: QueueBackupEnvelope["summary"]): Promise<QueueBackupEnvelope> {
  if (typeof passphrase !== "string" || passphrase.length < BACKUP_MIN_PASSPHRASE) {
    throw new Error(`Choose a passphrase of at least ${BACKUP_MIN_PASSPHRASE} characters.`);
  }
  const c = cryptoApi();
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, BACKUP_KDF_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(content));
  const sealed = new Uint8Array(await c.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    summary,
    data: b64(sealed),
  };
}

/** Decrypt a backup envelope (support tooling and tests). Throws on a wrong passphrase / tampered file. */
export async function decryptBackup(env: QueueBackupEnvelope, passphrase: string): Promise<unknown> {
  if (env.format !== BACKUP_FORMAT) throw new Error("Not a Breadee queue backup.");
  const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const key = await deriveKey(passphrase, unb64(env.kdf.salt), env.kdf.iterations);
  const plain = await cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: unb64(env.cipher.iv) }, key, unb64(env.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

const UNSETTLED = ["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"];

/**
 * Build the encrypted backup of THIS device's unsynced work: every unsettled operation (with its payload — the
 * data needed to recover it), every capture-store sale not yet synced, and every open / refused / settled-unsynced
 * Dine-In session. Read-only.
 */
export async function buildQueueBackup(passphrase: string): Promise<QueueBackupEnvelope> {
  const { localdb } = await import("@/lib/offline/db");
  const operations = await localdb.operations.where("status").anyOf(UNSETTLED).toArray();
  const captures = (await localdb.posOfflineTxns.toArray().catch(() => [])).filter((t) => t.status !== "synced");
  const sessions = (await localdb.dineDrafts.toArray().catch(() => [])).filter((d) => d.status !== "closed" && d.status !== "withdrawn");
  return encryptBackup({ operations, captures, sessions }, passphrase, { operations: operations.length, capture_rows: captures.length, sessions: sessions.length });
}

/** Offer the backup as a file download (WebView2 shows its Save prompt). Returns the file name. */
export function downloadBackup(env: QueueBackupEnvelope): string {
  const name = `breadee-queue-backup-${env.created_at.replace(/[:.]/g, "-")}.json`;
  const blob = new Blob([JSON.stringify(env)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return name;
}

/** Test hook. */
export function __resetDurabilityForTests(): void {
  persistAsked = null;
}
