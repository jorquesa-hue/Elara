// Rate limiting — a zero-dependency token-bucket limiter. Each key (a tenant+actor,
// or an anonymous bucket pre-auth) gets a bucket that refills continuously at a
// fixed rate up to a capacity; a request takes one token or is refused with the
// seconds to wait. In-memory and per-instance — the App runs single-instance
// (in-memory state), so this bounds abuse from one authenticated principal without
// a shared cache. An edge/CDN layer still fronts unauthenticated floods.

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left in the bucket after this call. */
  remaining: number;
  /** Seconds until at least one token is available (0 when allowed). */
  retryAfterSec: number;
  /** Bucket capacity (for an X-RateLimit-Limit header). */
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export interface RateLimiterOptions {
  /** Maximum burst — tokens a fresh bucket holds. */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSec: number;
  /** Monotonic-ish clock in milliseconds; injectable for tests. */
  nowMs?: () => number;
  /** Drop idle buckets after this many ms of inactivity (memory hygiene). */
  idleEvictMs?: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly nowMs: () => number;
  private readonly idleEvictMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    if (opts.capacity <= 0) throw new Error('RateLimiter capacity must be positive');
    if (opts.refillPerSec <= 0) throw new Error('RateLimiter refillPerSec must be positive');
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.idleEvictMs = opts.idleEvictMs ?? 5 * 60_000;
  }

  /** Attempt to spend one token for `key`. Pure w.r.t. the injected clock. */
  take(key: string): RateLimitDecision {
    const now = this.nowMs();
    this.evictIdle(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedMs: now };
    // Continuous refill since last touch.
    const elapsedSec = Math.max(0, (now - bucket.updatedMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updatedMs = now;

    let decision: RateLimitDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0, limit: this.capacity };
    } else {
      const deficit = 1 - bucket.tokens;
      decision = { allowed: false, remaining: 0, retryAfterSec: Math.ceil(deficit / this.refillPerSec), limit: this.capacity };
    }
    this.buckets.set(key, bucket);
    return decision;
  }

  private evictIdle(now: number): void {
    // Cheap opportunistic sweep — only when the map has grown enough to matter.
    if (this.buckets.size < 1024) return;
    for (const [k, b] of this.buckets) {
      if (now - b.updatedMs > this.idleEvictMs) this.buckets.delete(k);
    }
  }
}
