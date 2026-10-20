import { createRoot } from "react-dom/client";
import { OfflineIndicator } from "../src/offline/OfflineIndicator";
const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<OfflineIndicator />);
