import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';

/** Sliding 60 second window (docs/05-security.md §8). */
export class RateLimiter {
  #hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(cost = 1): Result<true> {
    const cutoff = this.now() - 60_000;
    this.#hits = this.#hits.filter((ts) => ts > cutoff);
    if (this.#hits.length + cost > this.limit) {
      return err(
        'E_POLICY',
        'rate limit exceeded',
        `${this.limit} calls per minute; wait a moment and retry`,
      );
    }
    for (let index = 0; index < cost; index += 1) this.#hits.push(this.now());
    return ok(true);
  }
}
