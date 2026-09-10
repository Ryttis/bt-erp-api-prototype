import { ApiError } from './errors.js';

type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Bounded, per-app gate. A rejected/timed-out waiter is removed before it can run. */
export class AnalyticsGate {
  #active = 0;
  #queue: Waiter[] = [];

  constructor(readonly limit: number, readonly queueLimit: number, readonly queueTimeoutMs: number) {}

  get active() { return this.#active; }
  get waiting() { return this.#queue.length; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.queueLimit) return Promise.reject(new ApiError(503, 'SERVICE_BUSY', 'Analytical service is busy'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => { clearTimeout(waiter.timer); this.#active++; resolve(); }, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(new ApiError(503, 'SERVICE_BUSY', 'Analytical service is busy'));
      }, this.queueTimeoutMs);
      this.#queue.push(waiter);
    });
  }

  #release() {
    this.#active--;
    const waiter = this.#queue.shift();
    if (waiter) waiter.resolve();
  }
}
