/** A bare widget that handles Tab with `walkTab` (lib/a11y/tabWalk.ts), as the link card and the database table do. */
import { walkTab } from "../../../packages/core/src/lib/a11y/tabWalk";

const widget = document.getElementById("widget")!;
const log: Array<{ handled: boolean; prevented: boolean }> = [];
widget.addEventListener("keydown", (e) => {
  const handled = walkTab(e, widget);
  log.push({ handled, prevented: e.defaultPrevented });
});
Object.assign(window, { tabWalkLog: log, tabWalkReady: true });
