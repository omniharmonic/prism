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
const PlaceholderRenderer = lazy(() => import("./PlaceholderRenderer"));

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
};

export function getRenderer(type: ContentType): React.LazyExoticComponent<ComponentType<RendererProps>> {
  return RENDERER_MAP[type] || PlaceholderRenderer;
}
