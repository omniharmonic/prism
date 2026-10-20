import { useSyncExternalStore } from "react";
import { getRegionPrefs, subscribeRegionPrefs, SYSTEM_REGION, type RegionPrefs } from "./preferences";

/**
 * Subscribe a component to the regional preferences: it re-renders — and so re-formats the
 * dates it shows through `lib/datetime/format` — when one changes (here or on another device).
 * Call it in every component that renders a formatted date.
 */
export function useRegionPrefs(): RegionPrefs {
  return useSyncExternalStore(subscribeRegionPrefs, getRegionPrefs, () => SYSTEM_REGION);
}
