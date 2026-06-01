/**
 * Rate limit config + Worker (Cache API) checker.
 * apii uses express-rate-limit with the same RATE_LIMITS buckets.
 */

const RATE_LIMIT_MESSAGE = "Too many requests, please try again later.";

/** @type {Record<string, { windowMs: number, max: number }>} */
const RATE_LIMITS = {
  /** Homepage, trending, config, docs */
  browse: { windowMs: 60_000, max: 100 },
  /** Search (expensive upstream) */
  search: { windowMs: 60_000, max: 35 },
  /** Search suggest autocomplete */
  suggest: { windowMs: 60_000, max: 80 },
  /** Info, sources, recommend, popular */
  meta: { windowMs: 60_000, max: 50 },
  /** Video/subtitle proxy — many Range requests per playback */
  stream: { windowMs: 15 * 60_000, max: 4000 }
};

function getRateLimitBucket(pathname) {
  if (!pathname || pathname === "/health") return null;
  if (pathname.startsWith("/api/download") || pathname.startsWith("/api/subtitles")) {
    return "stream";
  }
  if (pathname.startsWith("/api/search-suggest/")) return "suggest";
  if (pathname.startsWith("/api/search/")) return "search";
  if (
    pathname.startsWith("/api/info/") ||
    pathname.startsWith("/api/sources/") ||
    pathname.startsWith("/api/recommend/") ||
    pathname === "/api/popular-searches"
  ) {
    return "meta";
  }
  if (
    pathname === "/api/homepage" ||
    pathname === "/api/trending" ||
    pathname === "/api/config" ||
    pathname === "/" ||
    pathname === ""
  ) {
    return "browse";
  }
  return "browse";
}

function getClientIpFromRequest(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("True-Client-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/**
 * Edge rate limit via Cloudflare Cache API (shared per POP).
 * @returns {Promise<{ allowed: boolean, retryAfter?: number, remaining?: number }>}
 */
async function checkRateLimit(request, bucket) {
  const limits = RATE_LIMITS[bucket] || RATE_LIMITS.browse;
  const ip = getClientIpFromRequest(request);
  const windowSec = Math.ceil(limits.windowMs / 1000);
  const cacheKey = new Request(`https://rate-limit.internal/${bucket}/${encodeURIComponent(ip)}`);
  const cache = caches.default;

  let count = 0;
  const existing = await cache.match(cacheKey);
  if (existing) {
    count = parseInt(await existing.text(), 10) || 0;
  }

  if (count >= limits.max) {
    return { allowed: false, retryAfter: windowSec };
  }

  count += 1;
  await cache.put(
    cacheKey,
    new Response(String(count), {
      headers: { "Cache-Control": `max-age=${windowSec}` }
    })
  );

  return { allowed: true, remaining: limits.max - count };
}

module.exports = {
  RATE_LIMITS,
  RATE_LIMIT_MESSAGE,
  getRateLimitBucket,
  getClientIpFromRequest,
  checkRateLimit
};
