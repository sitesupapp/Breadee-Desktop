// Offline-first recovery — MEASURED interaction timings.
//
// The recovery plan forbids calling the UI "fast" without evidence, so the critical interactions
// (offline sign-in, cold start to POS, menu / floor / customer reads, Drawer, Orders History, shift
// restore, route transitions) record their real durations here. Samples live in memory and are
// mirrored (bounded) to localStorage so a measurement taken across a cold restart survives it; the
// native acceptance harness reads them through `window.__breadeeTimings`. Nothing here is sent
// anywhere, and nothing here can fail an interaction.

export type TimingSample = { name: string; ms: number; at: number; offline: boolean };
export type TimingStats = { n: number; p50: number; p95: number; p99: number; max: number };

const STORAGE_KEY = "breadee-desktop-timings";
const MAX_SAMPLES = 2000;

let samples: TimingSample[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function all(): TimingSample[] {
  if (samples) return samples;
  samples = [];
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as TimingSample[]) : [];
    if (Array.isArray(parsed)) samples = parsed.filter((s) => s && typeof s.name === "string" && Number.isFinite(s.ms)).slice(-MAX_SAMPLES);
  } catch {
    samples = [];
  }
  return samples;
}

function schedulePersist(): void {
  if (persistTimer !== null || typeof localStorage === "undefined") return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all().slice(-MAX_SAMPLES)));
    } catch {
      /* quota: in-memory samples are still readable */
    }
  }, 500);
}

/** A monotonic start mark. */
export function markStart(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Record `name` as the time elapsed since `start` (from markStart). Never throws. */
export function recordSince(name: string, start: number): number {
  const ms = Math.max(0, markStart() - start);
  recordTiming(name, ms);
  return ms;
}

export function recordTiming(name: string, ms: number): void {
  try {
    const list = all();
    list.push({ name, ms: Math.round(ms * 10) / 10, at: Date.now(), offline: typeof navigator !== "undefined" ? navigator.onLine === false : false });
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
    schedulePersist();
  } catch {
    /* observability only */
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** PURE — p50/p95/p99/max per timing name. */
export function summarize(list: TimingSample[]): Record<string, TimingStats> {
  const by = new Map<string, number[]>();
  for (const s of list) {
    const arr = by.get(s.name) ?? [];
    arr.push(s.ms);
    by.set(s.name, arr);
  }
  const out: Record<string, TimingStats> = {};
  for (const [name, arr] of by) {
    const sorted = [...arr].sort((a, b) => a - b);
    out[name] = { n: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] };
  }
  return out;
}

export function timingSamples(): TimingSample[] {
  return [...all()];
}

export function clearTimings(): void {
  samples = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __breadeeTimings?: unknown }).__breadeeTimings = {
    samples: timingSamples,
    summary: () => summarize(all()),
    clear: clearTimings,
  };
}
