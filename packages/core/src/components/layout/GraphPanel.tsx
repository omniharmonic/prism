import { GraphExplorer } from "./GraphExplorer";
export default function GraphPanel({ noteId }: { noteId: string }) {
  return <GraphExplorer noteId={noteId} />;
}
