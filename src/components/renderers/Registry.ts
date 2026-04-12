import { lazy, type ComponentType } from "react";
import type { ContentType } from "../../lib/types";
import type { RendererProps } from "./RendererProps";

// Lazy-loaded renderers — each loaded only when first needed
const DocumentRenderer = lazy(() => import("./DocumentRenderer"));
const MessageRenderer = lazy(() => import("./MessageRenderer"));
const EmailRenderer = lazy(() => import("./EmailRenderer"));
const CalendarRenderer = lazy(() => import("./CalendarRenderer"));
const CodeRenderer = lazy(() => import("./CodeRenderer"));
const PresentationRenderer = lazy(() => import("./PresentationRenderer"));
const TaskBoardRenderer = lazy(() => import("./TaskBoardRenderer"));
const ProjectRenderer = lazy(() => import("./ProjectRenderer"));
const SpreadsheetRenderer = lazy(() => import("./SpreadsheetRenderer"));
const WebsiteRenderer = lazy(() => import("./WebsiteRenderer"));
const DashboardRenderer = lazy(() => import("./DashboardRenderer"));
const CanvasRenderer = lazy(() => import("./CanvasRenderer"));
const PlaceholderRenderer = lazy(() => import("./PlaceholderRenderer"));
const MessagesDashboardRenderer = lazy(() => import("../comms/MessagesDashboard"));
const CalendarDashboardRenderer = lazy(() => import("../comms/CalendarDashboard"));
const VaultMessagesDashboardRenderer = lazy(() => import("../comms/VaultMessagesDashboard"));

const RENDERER_MAP: Partial<Record<ContentType, React.LazyExoticComponent<ComponentType<RendererProps>>>> = {
  document: DocumentRenderer,
  note: DocumentRenderer,
  briefing: DocumentRenderer,
  "message-thread": MessageRenderer,
  email: EmailRenderer,
  event: CalendarRenderer,
  code: CodeRenderer,
  presentation: PresentationRenderer,
  task: TaskBoardRenderer,
  "task-board": TaskBoardRenderer,
  project: ProjectRenderer,
  spreadsheet: SpreadsheetRenderer,
  website: WebsiteRenderer,
  dashboard: DashboardRenderer,
  canvas: CanvasRenderer,
  "messages-dashboard": MessagesDashboardRenderer,
} as Record<string, React.LazyExoticComponent<ComponentType<RendererProps>>>;

// Virtual dashboard renderers (not in ContentType union)
(RENDERER_MAP as any)["calendar-dashboard"] = CalendarDashboardRenderer;
(RENDERER_MAP as any)["vault-messages"] = VaultMessagesDashboardRenderer;

export function getRenderer(type: ContentType): React.LazyExoticComponent<ComponentType<RendererProps>> {
  return RENDERER_MAP[type] || PlaceholderRenderer;
}
