/**
 * Small concurrency primitives for the media/map proxies.
 *
 * `Semaphore` is a counting semaphore with a BOUNDED wait queue and a wait
 * deadline: a caller either gets a slot, waits (up to `waitMs`) for one, or is
 * refused with `BusyError`. `KeyedSemaphore` gives each key (a user) its own
 * semaphore, so one user saturating their slots never consumes anyone else's.
 */
export class BusyError extends Error {
  constructor() {
    super("busy");
  }
}

export class Semaphore {
  private active = 0;
  private waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    readonly max: number,
    readonly maxQueue: number,
  ) {}

  get inUse(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  /** Acquire a slot; resolves to its release function. Throws BusyError when full past `waitMs`. */
  acquire(waitMs: number): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant(); // hand the slot over directly (active unchanged)
      } else {
        this.active--;
      }
    };
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(release);
    }
    if (waitMs <= 0 || this.waiters.length >= this.maxQueue) return Promise.reject(new BusyError());
    return new Promise((resolve, reject) => {
      const w = {
        grant: () => resolve(release),
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new BusyError());
        }, waitMs),
      };
      this.waiters.push(w);
    });
  }
}

/** One semaphore per key; idle keys are dropped so the map can't grow without bound. */
export class KeyedSemaphore {
  private sems = new Map<string, Semaphore>();
  constructor(
    readonly max: number,
    readonly maxQueue: number,
  ) {}

  async acquire(key: string, waitMs: number): Promise<() => void> {
    let s = this.sems.get(key);
    if (!s) {
      s = new Semaphore(this.max, this.maxQueue);
      this.sems.set(key, s);
    }
    const sem = s;
    const release = await sem.acquire(waitMs).catch((e) => {
      if (sem.inUse === 0 && sem.queued === 0) this.sems.delete(key);
      throw e;
    });
    return () => {
      release();
      if (sem.inUse === 0 && sem.queued === 0 && this.sems.get(key) === sem) this.sems.delete(key);
    };
  }

  inUse(key: string): number {
    return this.sems.get(key)?.inUse ?? 0;
  }
}
