/** Device-local exploration settings only. Never stores node titles or content. */
export interface GraphCamera {
  zoom: number;
  x: number;
  y: number;
}
export interface GraphView {
  centers: string[];
  depth: number;
  mode: "2D" | "List" | "3D";
  relation: string;
  search: string;
  camera: GraphCamera;
}
interface Entry {
  key: string;
  at: number;
  view: GraphView;
}
const storageKey = "prism:graph-views:v1";
export const defaultGraphCamera = (): GraphCamera => ({ zoom: 1, x: 0, y: 0 });
function validView(value: unknown): value is GraphView {
  if (!value || typeof value !== "object") return false;
  const v = value as GraphView;
  return (
    Array.isArray(v.centers) &&
    v.centers.length > 0 &&
    v.centers.length <= 50 &&
    v.centers.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
    ) &&
    [1, 2, 3].includes(v.depth) &&
    ["2D", "List", "3D"].includes(v.mode) &&
    typeof v.relation === "string" &&
    v.relation.length <= 200 &&
    typeof v.search === "string" &&
    v.search.length <= 500 &&
    !!v.camera &&
    Number.isFinite(v.camera.zoom) &&
    v.camera.zoom >= 0.6 &&
    v.camera.zoom <= 2 &&
    Number.isFinite(v.camera.x) &&
    Math.abs(v.camera.x) <= 20 &&
    Number.isFinite(v.camera.y) &&
    Math.abs(v.camera.y) <= 20
  );
}
function entries(): Entry[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  if (raw.length > 2_000_000) throw Error("Saved views are unavailable.");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw Error("Saved views are unavailable.");
  return parsed
    .filter(
      (entry): entry is Entry =>
        !!entry &&
        typeof entry.key === "string" &&
        entry.key.length <= 10000 &&
        Number.isFinite(entry.at) &&
        entry.at >= 0 &&
        entry.at <= Date.now() &&
        validView(entry.view),
    )
    .slice(-50);
}
export function readGraphView(key: string): GraphView | null {
  return entries().find((entry) => entry.key === key)?.view ?? null;
}
export function saveGraphView(key: string, view: GraphView | null) {
  if (view && !validView(view))
    throw Error("This view cannot be saved. Reset its position and try again.");
  const next = entries().filter((entry) => entry.key !== key);
  if (view) next.push({ key, at: Date.now(), view });
  localStorage.setItem(storageKey, JSON.stringify(next.slice(-50)));
  window.dispatchEvent(new Event("prism:graph-view-changed"));
}
