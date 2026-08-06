// The Dine-In table map.
//
// Column counts come from the SAME measured-width resolver Takeaway uses, so
// Windows display scaling behaves identically across both routes and there is
// only one place to change a tier. The grid scrolls on its own - the page never
// does.

import { forwardRef } from "react";
import { Badge, EmptyState, ErrorState, Input, Skeleton, StatusDot } from "@/components/ui";
import { TableCard } from "@/components/pos/TableCard";
import type { LayoutSpec } from "@/lib/layout";
import type { TableMap as TableMapModel, TableSummary } from "@/types/tables";

export type TableMapProps = {
  map: TableMapModel;
  visible: TableSummary[];
  layout: LayoutSpec;
  selectedTableId: string | null;
  focusedTableId: string | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  query: string;
  now: number;
  onQueryChange: (q: string) => void;
  onSelect: (id: string) => void;
  onRetry: () => void;
};

export const TableMap = forwardRef<HTMLInputElement, TableMapProps>(function TableMap(props, searchRef) {
  const { map, visible, layout } = props;

  return (
    <>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="Search tables (Ctrl+F)"
          className="max-w-xs"
        />
        <Badge tone="slate">{map.available} free</Badge>
        <Badge tone="amber">{map.occupied} occupied</Badge>
        <Badge tone="blue">{map.configured} configured</Badge>
        {props.refreshing && (
          <Badge tone="slate">
            <StatusDot tone="slate" />
            Refreshing
          </Badge>
        )}
        {props.stale && !props.refreshing && (
          <Badge tone="amber" title="This map may be out of date">
            <StatusDot tone="amber" />
            May be out of date
          </Badge>
        )}
        {/* Operationally useful: explains why a free legacy table is not shown. */}
        {map.legacy_hidden > 0 && (
          <Badge tone="slate" title="Free non-configured tables are hidden by the server">
            {map.legacy_hidden} legacy hidden
          </Badge>
        )}
      </div>

      {props.loading && (
        <div
          className="grid flex-1 content-start gap-3"
          style={{ gridTemplateColumns: `repeat(${layout.menuColumns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: layout.menuColumns * 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px]" />
          ))}
        </div>
      )}

      {!props.loading && props.error && (
        <ErrorState title="The table map could not be loaded" message={props.error} onRetry={props.onRetry} />
      )}

      {!props.loading && !props.error && visible.length === 0 && (
        <EmptyState
          title={map.tables.length === 0 ? "No tables to show" : "No tables match"}
          hint={
            map.tables.length === 0
              ? "This branch has no configured tables. Table configuration is managed in the web POS settings."
              : "Try a different search."
          }
        />
      )}

      {!props.loading && !props.error && visible.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${layout.menuColumns}, minmax(0, 1fr))` }}
          >
            {visible.map((t) => (
              <TableCard
                key={t.id}
                table={t}
                selected={t.id === props.selectedTableId}
                focused={t.id === props.focusedTableId}
                stale={props.stale}
                now={props.now}
                onSelect={() => props.onSelect(t.id)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
});
