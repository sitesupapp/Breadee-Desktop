// A tiny in-memory PostgREST stand-in for "@/lib/supabase" (PERF hot-path tests only; registered by
// test/support/perf-supabase-hook.mjs from that test). Supports the builder calls the order loaders use:
// select / eq / lt / gte / in / order / limit, awaited as { data, error }. Records every query.

type Row = Record<string, unknown>;
export const tables: Record<string, Row[]> = {};
export const queries: { table: string; ops: [string, unknown[]][] }[] = [];

class Query implements PromiseLike<{ data: Row[]; error: null }> {
  ops: [string, unknown[]][] = [];
  private table: string;
  constructor(table: string) {
    this.table = table;
    queries.push({ table, ops: this.ops });
  }
  private push(op: string, args: unknown[]) {
    this.ops.push([op, args]);
    return this;
  }
  select(...a: unknown[]) { return this.push("select", a); }
  eq(...a: unknown[]) { return this.push("eq", a); }
  lt(...a: unknown[]) { return this.push("lt", a); }
  gte(...a: unknown[]) { return this.push("gte", a); }
  in(...a: unknown[]) { return this.push("in", a); }
  order(...a: unknown[]) { return this.push("order", a); }
  limit(...a: unknown[]) { return this.push("limit", a); }
  private run(): Row[] {
    let rows = [...(tables[this.table] ?? [])];
    for (const [op, a] of this.ops) {
      const [col, v] = a as [string, unknown];
      if (op === "eq") rows = rows.filter((r) => r[col] === v);
      else if (op === "lt") rows = rows.filter((r) => String(r[col]) < String(v));
      else if (op === "gte") rows = rows.filter((r) => String(r[col]) >= String(v));
      else if (op === "in") rows = rows.filter((r) => (v as unknown[]).includes(r[col]));
      else if (op === "order") {
        const asc = (a[1] as { ascending?: boolean } | undefined)?.ascending !== false;
        rows.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0) * (asc ? 1 : -1));
      } else if (op === "limit") rows = rows.slice(0, a[0] as number);
    }
    return rows;
  }
  then<A, B>(ok?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve({ data: this.run(), error: null as null }).then(ok, bad);
  }
}

export const supabase = { from: (t: string) => new Query(t) };
