/**
 * Simple in-memory rate limiter.
 *
 * Tradeoffs vs. a Redis-backed limiter:
 *   - Pros: zero dependencies, zero cost, works instantly on Vercel
 *   - Cons: resets on cold start, not shared across concurrent function instances
 *
 * For a demo/work-sample this is fine. For production at scale,
 * swap the store for Upstash Redis or Vercel KV.
 */

// Map of IP -> { count, windowStart }
const store = new Map();

const WINDOW_MS = 60 * 1000;  // 1 minute window
const MAX_REQUESTS = 10;       // 10 requests per IP per window

/**
 * Returns { allowed: bool, remaining: int, retryAfter: int (seconds) }
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const record = store.get(ip);

  // First request from this IP, or window has expired — reset
  if (!record || now - record.windowStart > WINDOW_MS) {
    store.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: MAX_REQUESTS - 1, retryAfter: 0 };
  }

  // Within window — increment and check
  record.count += 1;
  store.set(ip, record);

  if (record.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - record.windowStart)) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: MAX_REQUESTS - record.count, retryAfter: 0 };
}

// Periodically clean up expired entries so the map doesn't grow forever.
// Vercel functions are short-lived so this rarely matters, but it's good hygiene.
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of store.entries()) {
    if (now - record.windowStart > WINDOW_MS) {
      store.delete(ip);
    }
  }
}, WINDOW_MS);

module.exports = { checkRateLimit };
