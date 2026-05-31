/**
 * Cloudflare Worker — main MovieBox API (no stream/download proxy).
 * Stream URLs in /api/sources point to STREAM_PROXY_URL (VPS / Heroku).
 */
import * as api from "./lib/api-handlers.cjs";

const JSON_HEADERS = {
  ...api.CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

function cacheHeaders(maxAge, scope = "public") {
  const s = Math.min(maxAge, 3600);
  return {
    "Cache-Control": `${scope}, max-age=${s}, s-maxage=${maxAge}, stale-while-revalidate=${s}`
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: api.CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return json({ status: "error", message: "Method not allowed" }, 405);
    }

    const proxyOrigin = api.getProxyOriginFromEnv(env, request.url);

    try {
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(getDocsHtml(proxyOrigin), {
          headers: { ...api.CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" }
        });
      }

      if (url.pathname === "/api/config") {
        return json(api.handleAppConfigData(), 200, cacheHeaders(60));
      }

      if (url.pathname === "/api/homepage") {
        const payload = await api.getHomepage();
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.homepage));
      }

      if (url.pathname === "/api/trending") {
        const page = parseInt(url.searchParams.get("page")) || 0;
        const perPage = parseInt(url.searchParams.get("perPage")) || 18;
        const payload = await api.getTrending(page, perPage);
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.trending));
      }

      const searchMatch = url.pathname.match(/^\/api\/search\/(.+)$/);
      if (searchMatch) {
        const keyword = decodeURIComponent(searchMatch[1]);
        const page = parseInt(url.searchParams.get("page"), 10);
        const perPage = parseInt(url.searchParams.get("perPage"), 10) || 24;
        const subjectType = parseInt(url.searchParams.get("type"), 10) || api.SubjectType.ALL;
        const payload = await api.searchViaProxy(
          proxyOrigin,
          keyword,
          Number.isFinite(page) ? page : api.SEARCH_DEFAULT_PAGE,
          perPage,
          subjectType
        );
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.search, "private"));
      }

      const infoMatch = url.pathname.match(/^\/api\/info\/([^/]+)$/);
      if (infoMatch) {
        const payload = await api.apiViaProxy(proxyOrigin, `/api/info/${infoMatch[1]}`);
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.info));
      }

      const suggestMatch = url.pathname.match(/^\/api\/search-suggest\/(.+)$/);
      if (suggestMatch) {
        const keyword = decodeURIComponent(suggestMatch[1]);
        const perPage = parseInt(url.searchParams.get("perPage"), 10) || api.SUGGEST_DEFAULT_PER_PAGE;
        const payload = await api.apiViaProxy(proxyOrigin, `/api/search-suggest/${encodeURIComponent(keyword)}`, {
          perPage: String(perPage)
        });
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.suggest, "private"));
      }

      if (url.pathname === "/api/popular-searches") {
        const payload = await api.apiViaProxy(proxyOrigin, "/api/popular-searches");
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.popular));
      }

      const recommendMatch = url.pathname.match(/^\/api\/recommend\/([^/]+)$/);
      if (recommendMatch) {
        const pageParam = parseInt(url.searchParams.get("page"), 10);
        const page = Number.isFinite(pageParam) ? pageParam : api.SEARCH_DEFAULT_PAGE;
        const perPage = parseInt(url.searchParams.get("perPage"), 10) || api.RECOMMEND_DEFAULT_PER_PAGE;
        const payload = await api.apiViaProxy(proxyOrigin, `/api/recommend/${recommendMatch[1]}`, {
          page: String(page),
          perPage: String(perPage)
        });
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.recommend));
      }

      const sourcesPath = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (sourcesPath) {
        const season = parseInt(url.searchParams.get("season")) || 0;
        const episode = parseInt(url.searchParams.get("episode")) || 0;
        const payload = await api.getSources(sourcesPath[1], season, episode, proxyOrigin);
        return json(payload, 200, cacheHeaders(api.CACHE_TTLS.sources));
      }

      return json(
        {
          status: "error",
          message: "Endpoint not found",
          availableEndpoints: [
            "GET /",
            "GET /api/config",
            "GET /api/homepage",
            "GET /api/trending",
            "GET /api/search/:query",
            "GET /api/info/:movieId",
            "GET /api/search-suggest/:query",
            "GET /api/popular-searches",
            "GET /api/recommend/:movieId",
            "GET /api/sources/:movieId"
          ],
          streamProxy: proxyOrigin
        },
        404
      );
    } catch (err) {
      return json({ status: "error", message: err.message || "Internal error" }, 500);
    }
  }
};

function getDocsHtml(streamProxyUrl) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MovieBox API</title>
<style>body{font-family:system-ui;background:#0d1117;color:#c9d1d9;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}
a{color:#58a6ff}code{background:#161b22;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>MovieBox API</h1>
<p>API principale: <strong>https://apiv1.freehandyflix.online</strong> (Cloudflare). Stream / download sur serveur séparé.</p>
<p><strong>Stream proxy (apii):</strong> <code>${streamProxyUrl}</code></p>
<p>Info v2 sur <strong>apiv1</strong> (proxy via apii). Suggest, popular, recommend sur apii.</p>
<h2>Endpoints</h2>
<ul>
<li><code>GET /api/config</code></li>
<li><code>GET /api/homepage</code></li>
<li><code>GET /api/trending</code></li>
<li><code>GET /api/search/:query</code></li>
<li><code>GET /api/info/:movieId</code></li>
<li><code>GET /api/search-suggest/:query</code></li>
<li><code>GET /api/popular-searches</code></li>
<li><code>GET /api/recommend/:movieId</code></li>
<li><code>GET /api/sources/:movieId</code> — <code>proxyUrl</code> pointe vers le stream proxy</li>
</ul>
<p>Documentation complète: déployer <code>index.js</code> en Node ou voir <code>index.js.backup</code>.</p>
</body></html>`;
}
