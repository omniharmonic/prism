/**
 * Hook that drives a single dashboard widget: fetches notes, applies
 * filter-engine transforms, and returns ready-to-render data.
 */
import { useMemo } from "react";
import { useNotes } from "./useParachute";
import {
  filterNotes,
  sortNotes,
  groupNotes,
  aggregateNotes,
} from "../../lib/dashboard/filter-engine";
import type { DashboardWidgetConfig } from "../../lib/dashboard/widget-registry";
import type { Note } from "../../lib/types";

export interface WidgetData {
  items: Note[];
  groups: Map<string, Note[]> | null;
  aggregate: number | null;
  isLoading: boolean;
}

export function useWidgetData(config: DashboardWidgetConfig): WidgetData {
  const source = config.source;

  // Use the first tag (if any) to narrow the Parachute query
  const primaryTag = source?.tags?.[0];
  const pathPrefix = source?.pathPrefix;

  const { data: rawNotes, isLoading } = useNotes({
    tag: primaryTag,
    path: pathPrefix,
  });

  const result = useMemo(() => {
    const allNotes = rawNotes ?? [];

    // 1. Filter
    let items = source ? filterNotes(allNotes, source) : allNotes;

    // 2. Sort
    if (config.sort) {
      items = sortNotes(items, config.sort);
    }

    // 3. Group
    let groups: Map<string, Note[]> | null = null;
    if (config.group) {
      groups = groupNotes(items, config.group);
    }

    // 4. Aggregate
    let aggregate: number | null = null;
    if (config.aggregateType) {
      aggregate = aggregateNotes(
        items,
        config.aggregateType,
        config.aggregateCondition,
      );
    }

    return { items, groups, aggregate };
  }, [rawNotes, source, config.sort, config.group, config.aggregateType, config.aggregateCondition]);

  return { ...result, isLoading };
}
