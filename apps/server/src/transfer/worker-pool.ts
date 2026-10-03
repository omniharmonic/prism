/**
 * One worker thread, one task at a time, a hard wall-clock limit per task.
 *
 * Everything in import/export whose cost depends on USER CONTENT in a way we do
 * not control — the Markdown parser, the HTML→Markdown converter (a DOM parser),
 * unzip + planning of an upload — runs here, never on the server's event loop.
 * A task that passes its deadline is killed with `worker.terminate()` (which
 * stops JavaScript mid-loop); the next task gets a fresh worker. The deadline
 * covers the TASK only: a worker announces `ready` once loaded, and a task's
 * clock starts when it is handed over. The worker is unref'd: it never keeps
 * the process alive.
 */
import { Worker } from "node:worker_threads";

export class WorkerTimeoutError extends Error {
  constructor() {
    super("worker_timeout");
  }
}
export class WorkerFailedError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
  }
}

interface Task {
  message: unknown;
  transfer: ArrayBuffer[];
  timeoutMs: number;
  sent: boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
interface Thread {
  worker: Worker;
  ready: boolean;
}
type Reply = { ready: true } | { ok: true; value: unknown } | { ok: false; error: string; code?: string; status?: number };

// The worker is started through `worker-boot.mjs`, which registers the TypeScript loader
// (tsx) inside the thread — a worker does not inherit the main thread's loader hooks.
// No exec flags are passed on (`--env-file`, `--test`… are not valid for a worker).
const ENTRY = new URL("./worker-boot.mjs", import.meta.url);
const BOOT_TIMEOUT_MS = 60_000;

export class TaskWorker {
  private thread: Thread | null = null;
  private queue: Task[] = [];
  private current: Task | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `workerData` reaches the thread as-is (`{ preload: "doc" }` loads the document converters before `ready`, outside any task's clock). */
  constructor(private readonly maxOldGenerationSizeMb: number, private readonly maxQueue = 64, private readonly workerData: unknown = undefined) {}

  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** Run one task. Rejects with WorkerTimeoutError when it runs longer than `timeoutMs` (queueing and worker start-up are not counted). */
  run<T>(message: unknown, timeoutMs: number, transfer: ArrayBuffer[] = [], front = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) return reject(new WorkerFailedError("busy", "busy", 503));
      const task: Task = { message, transfer, timeoutMs, sent: false, resolve: resolve as (v: unknown) => void, reject };
      // `front`: ahead of everything still waiting (never ahead of the running task).
      if (front) this.queue.unshift(task);
      else this.queue.push(task);
      this.pump();
    });
  }

  private spawn(): Thread {
    const worker = new Worker(ENTRY, { execArgv: [], workerData: this.workerData, resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb } });
    worker.unref();
    const thread: Thread = { worker, ready: false };
    // Every handler first checks that this is still THE thread: a killed worker's late
    // `exit` (or message) must never settle a task that belongs to its successor.
    worker.on("message", (m: Reply) => {
      if (this.thread !== thread) return;
      if ("ready" in m) {
        thread.ready = true;
        this.dispatch();
        return;
      }
      const task = this.settle();
      if (!task) return;
      if (m.ok) task.resolve(m.value);
      else task.reject(new WorkerFailedError(m.error, m.code, m.status));
      this.pump();
    });
    const died = () => {
      if (this.thread !== thread) return;
      this.thread = null;
      const task = this.settle();
      if (task) task.reject(new WorkerFailedError("worker_failed", "worker_failed"));
      this.pump();
    };
    worker.on("error", died);
    worker.on("exit", died);
    return thread;
  }

  private settle(): Task | null {
    const task = this.current;
    this.current = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return task;
  }

  /** Kill the thread and fail the task it holds (deadline passed, or it never came up). */
  private kill(error: Error): void {
    const thread = this.thread;
    this.thread = null;
    const task = this.settle();
    if (thread) void thread.worker.terminate();
    if (task) task.reject(error);
    this.pump();
  }

  private arm(ms: number, error: () => Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kill(error()), ms);
    this.timer.unref?.();
  }

  private pump(): void {
    if (this.current) return;
    const task = this.queue.shift();
    if (!task) return;
    this.current = task;
    if (!this.thread) {
      this.thread = this.spawn();
      this.arm(BOOT_TIMEOUT_MS, () => new WorkerFailedError("worker_failed", "worker_failed"));
    }
    this.dispatch();
  }

  private dispatch(): void {
    const task = this.current;
    const thread = this.thread;
    if (!task || task.sent || !thread?.ready) return;
    task.sent = true;
    // Past the deadline the thread is killed — it may be deep inside a parser.
    this.arm(task.timeoutMs, () => new WorkerTimeoutError());
    try {
      thread.worker.postMessage(task.message, task.transfer);
    } catch {
      this.kill(new WorkerFailedError("worker_failed", "worker_failed"));
    }
  }

  /**
   * Fail everything still WAITING (never the running task) with `busy`: nothing
   * about those inputs is known, and running them would spawn a thread each.
   */
  flush(): void {
    const waiting = this.queue;
    this.queue = [];
    // The task a death just promoted (a thread is booting for it, nothing was sent yet) counts as waiting.
    const next = this.current;
    if (next && !next.sent) {
      const thread = this.thread;
      this.thread = null;
      this.settle();
      if (thread) void thread.worker.terminate();
      waiting.unshift(next);
    }
    for (const task of waiting) task.reject(new WorkerFailedError("busy", "busy", 503));
  }

  /** Shutdown / test helper. */
  async stop(): Promise<void> {
    const thread = this.thread;
    this.thread = null;
    if (thread) await thread.worker.terminate();
  }
}
