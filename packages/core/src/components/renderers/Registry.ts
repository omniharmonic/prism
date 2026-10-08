import { lazy, type ComponentType } from "react";
import { retryImport } from "../../lib/retryImport";
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
const CanvasRenderer = lazy(() => retryImport(() => import("./CanvasRenderer"))); // the largest chunk (Excalidraw): one failed request is retried
const PlaceholderRenderer = lazy(() => import("./PlaceholderRenderer"));
const CalendarDashboardRenderer = lazy(() => import("../comms/CalendarDashboard"));
const MessagesDashboardRenderer = lazy(() => import("../comms/VaultMessagesDashboard"));
const AgentActivityRenderer = lazy(() => import("../agent/AgentActivity"));
const NetworkRenderer = lazy(() => import("./NetworkRenderer"));
const BioregionEntityRenderer = lazy(() => import("./BioregionEntityRenderer"));
const MapRenderer = lazy(() => import("./MapRenderer"));
const PeopleRenderer = lazy(() => import("../people/PeopleWorkspace"));
const AgentChatRenderer = lazy(() => import("../agent/AgentChat"));
const DatabaseRenderer = lazy(() => import("../database/DatabaseRenderer"));
const HomeRenderer = lazy(() => import("../home/Home"));
const NotificationsRenderer = lazy(() => import("../inbox/NotificationsInbox"));

const RENDERER_MAP: Partial<Record<ContentType, React.LazyExoticComponent<ComponentType<RendererProps>>>> = {
  document: DocumentRenderer,
  note: DocumentRenderer,
  briefing: DocumentRenderer,
  "message-thread": MessageRenderer,
  email: EmailRenderer,
  event: CalendarRenderer,
  code: CodeRenderer,
  presentation: PresentationRenderer,
  task: DocumentRenderer,
  "task-board": TaskBoardRenderer,
  project: ProjectRenderer,
  spreadsheet: SpreadsheetRenderer,
  website: WebsiteRenderer,
  dashboard: DashboardRenderer,
  canvas: CanvasRenderer,
  "messages-dashboard": MessagesDashboardRenderer,
  network: NetworkRenderer,
  "bioregion-entity": BioregionEntityRenderer,
  database: DatabaseRenderer,
} as Record<string, React.LazyExoticComponent<ComponentType<RendererProps>>>;

// Virtual dashboard renderers (not in ContentType union)
(RENDERER_MAP as any)["calendar-dashboard"] = CalendarDashboardRenderer;
(RENDERER_MAP as any)["vault-messages"] = MessagesDashboardRenderer;
(RENDERER_MAP as any)["agent-activity"] = AgentActivityRenderer;
(RENDERER_MAP as any)["map"] = MapRenderer;
(RENDERER_MAP as any)["people"] = PeopleRenderer;
(RENDERER_MAP as any)["agent-chat"] = AgentChatRenderer;
(RENDERER_MAP as any)["home"] = HomeRenderer;
(RENDERER_MAP as any)["notifications"] = NotificationsRenderer;

export function getRenderer(type: ContentType): React.LazyExoticComponent<ComponentType<RendererProps>> {
  return RENDERER_MAP[type] || PlaceholderRenderer;
}
