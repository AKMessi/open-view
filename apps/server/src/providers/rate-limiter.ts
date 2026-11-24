export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;

  constructor(capacity: number, refillIntervalMs: number) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    if (elapsed === 0) return;
    const added = (elapsed / this.refillIntervalMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}
