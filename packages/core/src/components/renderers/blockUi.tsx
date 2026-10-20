import type { ReactNode } from "react";
import { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2, MessageSquareText, ChevronRight } from "lucide-react";
import type { BlockColorName } from "../../editor/blocks";
import type { TurnIntoKind } from "../../lib/tiptap/blockCommands";

/** Icons shared by the block menu, the slash menu and the selection toolbar. */
export const TURN_INTO_ICONS: Record<TurnIntoKind, ReactNode> = {
  paragraph: <Type size={15} />,
  heading1: <Heading1 size={15} />,
  heading2: <Heading2 size={15} />,
  heading3: <Heading3 size={15} />,
  bulletList: <List size={15} />,
  orderedList: <ListOrdered size={15} />,
  taskList: <ListChecks size={15} />,
  blockquote: <Quote size={15} />,
  codeBlock: <Code2 size={15} />,
  callout: <MessageSquareText size={15} />,
  toggle: <ChevronRight size={15} />,
};

export function colorLabel(color: BlockColorName): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

/** Highlight backgrounds reuse the existing Highlight mark with a token value. */
export const highlightValue = (color: BlockColorName) => `var(--prism-color-${color}-bg)`;
