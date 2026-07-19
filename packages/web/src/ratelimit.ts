interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();
const IDLE_TTL_MS = 60 * 60 * 1000;
let lastSweep = 0;

// Token-bucket limiter (H3). Returns true when a token was consumed (allow), false
// when the bucket is empty (caller answers 429). Guards /login against brute force
// and /api/* against abuse; idle buckets are swept so memory stays bounded.
export function rateLimit(id: string, capacity: number, refillPerSec: number): boolean {
  const now = Date.now();
  if (now - lastSweep > 5 * 60 * 1000) {
    lastSweep = now;
    for (const [k, v] of buckets) if (now - v.last > IDLE_TTL_MS) buckets.delete(k);
  }
  let b = buckets.get(id);
  if (!b) {
    b = { tokens: capacity, last: now };
    buckets.set(id, b);
  }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
