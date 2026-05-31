// Shared API logic (Cloudflare Worker + optional Node)
// Set proxy URLs via STREAM_PROXY_URL / PROXY_ORIGIN

// ─── Mirror hosts & IP spoofing (same as worker) ────────────────────────────

const MIRROR_HOSTS = [
  "h5.aoneroom.com",
  "movieboxapp.in",
  "moviebox.pk"
];

function getRandomHost() {
  return MIRROR_HOSTS[Math.floor(Math.random() * MIRROR_HOSTS.length)];
}

const SPOOFER_IPS = [
  "196.207.55.12",    // Safaricom
  "196.207.32.10",    // Safaricom
  "196.207.128.50",   // Safaricom
  "196.207.64.30",    // Safaricom
  "41.90.64.100",     // Safaricom Mobile
  "41.90.100.50",     // Safaricom Mobile
  "41.90.200.25",     // Safaricom Mobile
  "105.163.0.42",     // Airtel Kenya
  "105.163.100.20",   // Airtel Kenya
  "105.163.156.10",   // Airtel Kenya
  "41.215.130.10",    // Telkom Kenya
  "41.215.160.50",    // Telkom Kenya
  "196.216.0.20",     // KENET
  "196.216.2.100",    // KENET
  "102.0.0.30",       // Faiba / Jamii
  "102.0.4.50",       // Faiba / Jamii
  "41.89.4.10",       // KENET education
  "41.76.180.20",     // Liquid Telecom Kenya
  "197.248.0.50"      // Safaricom Home
];

function getRandomIP() {
  return SPOOFER_IPS[Math.floor(Math.random() * SPOOFER_IPS.length)];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FMOVIES_ORIGIN = "https://fmoviesunblocked.net";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization"
};

const APP_CONFIG = {
  latestVersionCode: 3,
  minRequiredVersionCode: 3,
  maintenanceMode: true,
  maintenanceMessage: "Our app is currently undergoing maintenance please use our website...",
  updateUrl: "https://freehandyflix.online"
};

const SubjectType = { ALL: 0, MOVIES: 1, TV_SERIES: 2, MUSIC: 6 };

const HOST_URL = `https://${MIRROR_HOSTS[0]}`;

// ─── MovieBox API v2 (h5-api.aoneroom.com) — search uses v2 BFF ─────────────
// v1 POST /wefeed-h5-bff/web/subject/search returns empty; v2 is the live endpoint.
// Ref: https://github.com/Simatwa/moviebox-api (moviebox_api.v2.core.Search)

const API_V2_HOST = "h5-api.aoneroom.com";
const API_V2_BASE = `https://${API_V2_HOST}`;
const API_V2_REFERER = "https://videodownloader.site/";
const API_V2_SEARCH_URL = `${API_V2_BASE}/wefeed-h5api-bff/subject/search`;
const API_V2_DETAIL_URL = `${API_V2_BASE}/wefeed-h5api-bff/detail`;
const API_V2_SEARCH_SUGGEST_URL = `${API_V2_BASE}/wefeed-h5api-bff/subject/search-suggest`;
const API_V2_EVERYONE_SEARCH_URL = `${API_V2_BASE}/wefeed-h5api-bff/subject/everyone-search`;
const API_V2_DETAIL_REC_URL = `${API_V2_BASE}/wefeed-h5api-bff/subject/detail-rec`;

const API_V2_HEADERS = {
  "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
  "Accept-Language": "en-US,en;q=0.5",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
  Referer: API_V2_REFERER
};

const API_V2_JSON_HEADERS = {
  ...API_V2_HEADERS,
  "Content-Type": "application/json"
};

const SEARCH_DEFAULT_PAGE = 1;
const SEARCH_DEFAULT_PER_PAGE = 24;
const SUGGEST_DEFAULT_PER_PAGE = 10;
const RECOMMEND_DEFAULT_PER_PAGE = 24;

// ─── Protocol-aware origin builder (handles nginx/reverse-proxy HTTPS) ────────

function getWorkerOrigin(req) {
  const fwdProto = req.get("x-forwarded-proto");
  let proto = fwdProto ? fwdProto.split(",")[0].trim().replace(/:$/, "") : req.protocol;
  const host = req.get("host") || "localhost";
  // Behind nginx with SSL termination, x-forwarded-proto may not be set,
  // so req.protocol returns "http" even when the client used HTTPS.
  // Default to HTTPS for non-local hosts since production deployments use SSL.
  if (proto === "http" && !/^(localhost|127\.)/.test(host)) {
    proto = "https";
  }
  return `${proto}://${host}`;
}

// ─── Simple in-memory cache (replaces Cloudflare caches.default) ─────────────

const memoryCache = new Map();
const pendingCacheLoads = new Map();
const MAX_MEMORY_CACHE_ENTRIES = 500;

const CACHE_TTLS = {
  homepage: 43200,
  trending: 10800,
  search: 300,
  suggest: 300,
  popular: 600,
  info: 21600,
  recommend: 3600,
  sources: 1800
};

function cacheGet(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, maxAgeSeconds) {
  if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES && !memoryCache.has(key)) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { data, expiry: Date.now() + maxAgeSeconds * 1000 });
}

async function getOrSetCache(key, maxAgeSeconds, loader) {
  const cached = cacheGet(key);
  if (cached) return cached;
  if (pendingCacheLoads.has(key)) return pendingCacheLoads.get(key);

  const pending = Promise.resolve()
    .then(loader)
    .then((data) => {
      cacheSet(key, data, maxAgeSeconds);
      return data;
    })
    .finally(() => pendingCacheLoads.delete(key));

  pendingCacheLoads.set(key, pending);
  return pending;
}

function setCachedResponseHeaders(res, maxAgeSeconds, scope = "public") {
  res.set({
    ...CORS_HEADERS,
    "Cache-Control": `${scope}, max-age=${Math.min(maxAgeSeconds, 3600)}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${Math.min(maxAgeSeconds, 3600)}`
  });
}

// ─── Helper functions (kept intact from worker) ─────────────────────────────

function buildDefaultHeaders(host) {
  const ip = getRandomIP();
  return {
    "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
    "Accept-Language": "en-US,en;q=0.5",
    "Accept": "application/json",
    "User-Agent": "okhttp/4.12.0",
    "Referer": `https://${host}`,
    "Host": host,
    "Connection": "keep-alive",
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
}

function buildHeaders(host, extraHeaders = {}) {
  const headers = buildDefaultHeaders(host);
  for (const [key, val] of Object.entries(extraHeaders)) {
    if (val === void 0 || val === null) {
      delete headers[key];
    } else {
      headers[key] = val;
    }
  }
  return headers;
}

function cleanClientIp(value) {
  if (!value || typeof value !== "string") return "";
  const ip = value.split(",")[0].trim();
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip.startsWith("[") && ip.includes("]")) return ip.slice(1, ip.indexOf("]"));
  return ip;
}

function getClientIp(req) {
  const candidates = [
    req.get("cf-connecting-ip"),
    req.get("true-client-ip"),
    Array.isArray(req.ips) && req.ips.length > 0 ? req.ips[0] : "",
    req.ip,
    req.get("x-real-ip"),
    req.get("x-forwarded-for"),
    req.socket && req.socket.remoteAddress
  ];
  for (const candidate of candidates) {
    const ip = cleanClientIp(candidate);
    if (ip) return ip;
  }
  return "";
}

function processApiResponse(data) {
  if (data && data.data) return data.data;
  return data;
}

const SESSION_COOKIE_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE_FAILURE_TTL_MS = 60 * 1000;
let sessionCookieCache = { value: "", expiry: 0 };
let pendingSessionCookie = null;

async function fetchSessionCookie() {
  if (Date.now() < sessionCookieCache.expiry) {
    return sessionCookieCache.value;
  }
  if (pendingSessionCookie) return pendingSessionCookie;

  pendingSessionCookie = (async () => {
    const host = getRandomHost();
    const response = await fetch(
      `https://${host}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: buildHeaders(host) }
    );
    const cookie = response.headers.get("set-cookie") || "";
    sessionCookieCache = {
      value: cookie,
      expiry: Date.now() + (cookie ? SESSION_COOKIE_TTL_MS : SESSION_COOKIE_FAILURE_TTL_MS)
    };
    return cookie;
  })().catch(() => {
    sessionCookieCache = { value: "", expiry: Date.now() + SESSION_COOKIE_FAILURE_TTL_MS };
    return "";
  }).finally(() => {
    pendingSessionCookie = null;
  });

  return pendingSessionCookie;
}

async function fetchSubjectDetail(movieId) {
  return getOrSetCache(`info_v2_${movieId}`, CACHE_TTLS.info, async () => {
    const url = new URL(API_V2_DETAIL_URL);
    url.searchParams.set("subjectId", movieId);
    const data = await fetchV2Get(url.toString());
    const content = processApiResponse(data);
    addSubjectThumbnail(content);
    return content;
  });
}

function addSubjectThumbnail(content) {
  if (content && content.subject) {
    if (content.subject.cover && content.subject.cover.url) {
      content.subject.thumbnail = content.subject.cover.url;
    }
    if (content.subject.stills && content.subject.stills.url && !content.subject.thumbnail) {
      content.subject.thumbnail = content.subject.stills.url;
    }
  }
}

function addItemThumbnails(content) {
  if (content && content.items) {
    content.items.forEach((item) => {
      if (item.cover && item.cover.url) item.thumbnail = item.cover.url;
      if (item.stills && item.stills.url && !item.thumbnail) item.thumbnail = item.stills.url;
    });
  }
}

function addProcessedMedia(content, workerOrigin) {
  const payload = { ...content };
  if (content && content.downloads) {
    payload.processedSources = content.downloads.map((file) => ({
      id: file.id,
      quality: file.resolution || "Unknown",
      directUrl: file.url,
      proxyUrl: `${workerOrigin}/api/download/${encodeURIComponent(file.url)}`,
      size: file.size,
      format: "mp4"
    }));
  }
  if (content && content.captions && content.captions.length > 0) {
    payload.processedSubtitles = content.captions.map((cap) => ({
      id: cap.id,
      languageCode: cap.lan,
      languageName: cap.lanName,
      directUrl: cap.url,
      proxyUrl: `${workerOrigin}/api/subtitles/${encodeURIComponent(cap.url)}`,
      size: cap.size,
      delay: cap.delay || 0,
      format: "srt"
    }));
  }
  return payload;
}

async function makeApiRequest(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await fetchSessionCookie();
    const host = getRandomHost();
    const rewritten = new URL(url);
    rewritten.host = host;
    const headers = buildHeaders(host, options.headers || {});
    if (cookie) headers["Cookie"] = cookie;
    const fetchOptions = {
      method: options.method || "GET",
      headers,
      redirect: "follow"
    };
    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    try {
      const response = await fetch(rewritten.toString(), fetchOptions);
      if (!response.ok) {
        throw new Error(`Upstream HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchV2Get(url) {
  const response = await fetch(url, { headers: API_V2_HEADERS });
  if (!response.ok) {
    throw new Error(`MovieBox v2 HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function postV2Api(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: API_V2_JSON_HEADERS,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`MovieBox v2 HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

function buildSearchPayload(keyword, page, perPage, subjectType) {
  return {
    keyword,
    page,
    perPage,
    subjectType
  };
}

function filterSearchItems(content, subjectType) {
  if (subjectType !== SubjectType.ALL && content.items) {
    content.items = content.items.filter((item) => item.subjectType === subjectType);
  }
  addItemThumbnails(content);
  return content;
}

// ─── Route handlers (kept intact from worker, adapted for Express) ──────────

function handleAppConfig(req, res) {
  setCachedResponseHeaders(res, 60);
  return res.json(APP_CONFIG);
}

async function handleApiHomepage(req, res) {
  const payload = await getOrSetCache("homepage", CACHE_TTLS.homepage, async () => {
    const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/home`);
    return { status: "success", data: processApiResponse(data) };
  });
  setCachedResponseHeaders(res, CACHE_TTLS.homepage);
  return res.json(payload);
}

async function handleTrending(req, res) {
  const page = parseInt(req.query.page) || 0;
  const perPage = parseInt(req.query.perPage) || 18;
  const cacheKey = `trending_${page}_${perPage}`;
  const payload = await getOrSetCache(cacheKey, CACHE_TTLS.trending, async () => {
    const apiUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/trending`);
    apiUrl.searchParams.set("page", page);
    apiUrl.searchParams.set("perPage", perPage);
    apiUrl.searchParams.set("uid", "5591179548772780352");
    const data = await makeApiRequest(apiUrl.toString());
    return { status: "success", data: processApiResponse(data) };
  });
  setCachedResponseHeaders(res, CACHE_TTLS.trending);
  return res.json(payload);
}

async function handleSearch(req, res) {
  const encodedQuery = req.params.query;
  const pageParam = parseInt(req.query.page, 10);
  const page = Number.isFinite(pageParam) ? pageParam : SEARCH_DEFAULT_PAGE;
  const perPage = parseInt(req.query.perPage, 10) || SEARCH_DEFAULT_PER_PAGE;
  const subjectType = parseInt(req.query.type, 10) || SubjectType.ALL;
  const keyword = decodeURIComponent(encodedQuery);
  const payload = await search(keyword, page, perPage, subjectType);
  setCachedResponseHeaders(res, CACHE_TTLS.search, "private");
  return res.json(payload);
}

async function handleInfo(req, res) {
  const movieId = req.params.movieId;
  const content = await fetchSubjectDetail(movieId);
  setCachedResponseHeaders(res, CACHE_TTLS.info);
  return res.json({ status: "success", data: content });
}
function getProxyOriginFromEnv(env, requestUrl) {
  const fromEnv = env?.STREAM_PROXY_URL || env?.PROXY_ORIGIN || process?.env?.STREAM_PROXY_URL || process?.env?.PROXY_ORIGIN;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  if (requestUrl) return new URL(requestUrl).origin;
  return "http://localhost:7861";
}

function getRequestOrigin(headers) {
  const host = headers.get("host") || "localhost";
  let proto = (headers.get("x-forwarded-proto") || "https").split(",")[0].trim().replace(/:$/, "");
  if (proto === "http" && !/^(localhost|127\.)/.test(host)) proto = "https";
  return proto + "://" + host;
}

module.exports = {
  MIRROR_HOSTS,
  CORS_HEADERS,
  APP_CONFIG,
  SubjectType,
  CACHE_TTLS,
  cacheGet,
  cacheSet,
  getOrSetCache,
  setCachedResponseHeaders,
  buildHeaders,
  getClientIpFromHeaders,
  processApiResponse,
  fetchSubjectDetail,
  addProcessedMedia,
  makeApiRequest,
  handleAppConfigData: () => APP_CONFIG,
  getHomepage,
  getTrending,
  search,
  searchViaProxy,
  getSearchSuggest,
  getPopularSearches,
  getRecommend,
  apiViaProxy,
  SEARCH_DEFAULT_PAGE,
  SEARCH_DEFAULT_PER_PAGE,
  SUGGEST_DEFAULT_PER_PAGE,
  RECOMMEND_DEFAULT_PER_PAGE,
  getInfo,
  getSources,
  getProxyOriginFromEnv,
  getRequestOrigin
};

async function getClientIpFromHeaders(headers) {
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("true-client-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")
  ];
  for (const candidate of candidates) {
    const ip = cleanClientIp(candidate);
    if (ip) return ip;
  }
  return "";
}

async function getHomepage() {
  return getOrSetCache("homepage", CACHE_TTLS.homepage, async () => {
    const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/home`);
    return { status: "success", data: processApiResponse(data) };
  });
}

async function getTrending(page, perPage) {
  const cacheKey = `trending_${page}_${perPage}`;
  return getOrSetCache(cacheKey, CACHE_TTLS.trending, async () => {
    const apiUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/trending`);
    apiUrl.searchParams.set("page", page);
    apiUrl.searchParams.set("perPage", perPage);
    apiUrl.searchParams.set("uid", "5591179548772780352");
    const data = await makeApiRequest(apiUrl.toString());
    return { status: "success", data: processApiResponse(data) };
  });
}

async function search(keyword, page = SEARCH_DEFAULT_PAGE, perPage = SEARCH_DEFAULT_PER_PAGE, subjectType = SubjectType.ALL) {
  const cacheKey = `search_v2_${keyword.toLowerCase()}_${page}_${perPage}_${subjectType}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await postV2Api(
    API_V2_SEARCH_URL,
    buildSearchPayload(keyword, page, perPage, subjectType)
  );
  const content = filterSearchItems(processApiResponse(data), subjectType);
  const payload = { status: "success", data: content };
  if (content.items && content.items.length > 0) {
    cacheSet(cacheKey, payload, CACHE_TTLS.search);
  }
  return payload;
}

/** Generic GET via VPS proxy (apii) — avoids MovieBox 429 on Cloudflare Worker IPs. */
async function apiViaProxy(proxyOrigin, apiPath, query = {}) {
  const base = String(proxyOrigin).replace(/\/$/, "");
  const url = new URL(`${base}${apiPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`API proxy HTTP ${response.status}: invalid JSON`);
  }
  if (!response.ok || body.status === "error") {
    throw new Error(body.message || `API proxy HTTP ${response.status}`);
  }
  return body;
}

/** Search via VPS proxy (apii). */
async function searchViaProxy(proxyOrigin, keyword, page, perPage, subjectType) {
  const query = { page: String(page), perPage: String(perPage) };
  if (subjectType !== SubjectType.ALL) query.type = String(subjectType);
  return apiViaProxy(proxyOrigin, `/api/search/${encodeURIComponent(keyword)}`, query);
}

async function getSearchSuggest(keyword, perPage = SUGGEST_DEFAULT_PER_PAGE) {
  const cacheKey = `suggest_v2_${keyword.toLowerCase()}_${perPage}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await postV2Api(API_V2_SEARCH_SUGGEST_URL, { keyword, perPage });
  const payload = { status: "success", data: processApiResponse(data) };
  cacheSet(cacheKey, payload, CACHE_TTLS.suggest);
  return payload;
}

async function getPopularSearches() {
  return getOrSetCache("popular_searches_v2", CACHE_TTLS.popular, async () => {
    const data = await fetchV2Get(API_V2_EVERYONE_SEARCH_URL);
    return { status: "success", data: processApiResponse(data) };
  });
}

async function getRecommend(movieId, page = SEARCH_DEFAULT_PAGE, perPage = RECOMMEND_DEFAULT_PER_PAGE) {
  const cacheKey = `recommend_v2_${movieId}_${page}_${perPage}`;
  return getOrSetCache(cacheKey, CACHE_TTLS.recommend, async () => {
    const url = new URL(API_V2_DETAIL_REC_URL);
    url.searchParams.set("subjectId", movieId);
    url.searchParams.set("page", String(page));
    url.searchParams.set("perPage", String(perPage));
    const data = await fetchV2Get(url.toString());
    const content = processApiResponse(data);
    addItemThumbnails(content);
    return { status: "success", data: content };
  });
}

async function getInfo(movieId) {
  const content = await fetchSubjectDetail(movieId);
  return { status: "success", data: content };
}

async function getSources(movieId, season, episode, proxyOrigin) {
  const cacheKey = `sources_${movieId}_${season}_${episode}`;
  const content = await getOrSetCache(cacheKey, CACHE_TTLS.sources, async () => {
    const movieInfo = await fetchSubjectDetail(movieId);
    const detailPath = movieInfo?.subject?.detailPath;
    if (!detailPath) throw new Error("Could not get movie detail path for Referer header");
    const refererUrl = `${FMOVIES_ORIGIN}/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`;
    const sourcesUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/download`);
    sourcesUrl.searchParams.set("subjectId", movieId);
    sourcesUrl.searchParams.set("se", season);
    sourcesUrl.searchParams.set("ep", episode);
    const data = await makeApiRequest(sourcesUrl.toString(), {
      headers: { Referer: refererUrl, Origin: FMOVIES_ORIGIN }
    });
    return processApiResponse(data);
  });
  return { status: "success", data: addProcessedMedia(content, proxyOrigin) };
}
