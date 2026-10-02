import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
export interface PublicationPreviewProps {
  slug: string;
  draftRevision: number;
  onClose: () => void;
  /** Render the same authenticated saved-draft reader inside Site studio. */
  inline?: boolean;
  onExpand?: () => void;
}
const Context = createContext<ComponentType<PublicationPreviewProps> | null>(
  null,
);
/** Host-owned reader adapter keeps web routes/templates outside shared core. */
export function PublicationPreviewProvider({
  component,
  children,
}: {
  component: ComponentType<PublicationPreviewProps>;
  children: ReactNode;
}) {
  return <Context.Provider value={component}>{children}</Context.Provider>;
}
export const usePublicationPreview = () => useContext(Context);
