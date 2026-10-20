// Worker-thread entry. The server runs TypeScript through tsx; a worker thread does not
// inherit the main thread's loader hooks, so register them here before loading the worker.
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
