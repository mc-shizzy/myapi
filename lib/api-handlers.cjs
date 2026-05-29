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
  info: 21600,
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
  return getOrSetCache(`info_${movieId}`, CACHE_TTLS.info, async () => {
    const apiUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`);
    apiUrl.searchParams.set("subjectId", movieId);
    const data = await makeApiRequest(apiUrl.toString());
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
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 24;
  const subjectType = parseInt(req.query.type) || SubjectType.ALL;
  const clientIp = getClientIp(req);
  const keyword = decodeURIComponent(encodedQuery);
  const cacheKey = `search_${clientIp || "unknown"}_${keyword.toLowerCase()}_${page}_${perPage}_${subjectType}`;
  const payload = await getOrSetCache(cacheKey, CACHE_TTLS.search, async () => {
    const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/subject/search`, {
      method: "POST",
      body: {
        keyword,
        page,
        perPage,
        subjectType
      },
      headers: {
        "X-Forwarded-For": clientIp || void 0,
        "X-Real-IP": clientIp || void 0
      }
    });
    const content = processApiResponse(data);
    if (subjectType !== SubjectType.ALL && content.items) {
      content.items = content.items.filter((item) => item.subjectType === subjectType);
    }
    addItemThumbnails(content);
    return { status: "success", data: content };
  });
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

async function search(keyword, page, perPage, subjectType, clientIp) {
  const cacheKey = `search_${clientIp || "unknown"}_${keyword.toLowerCase()}_${page}_${perPage}_${subjectType}`;
  return getOrSetCache(cacheKey, CACHE_TTLS.search, async () => {
    const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/subject/search`, {
      method: "POST",
      body: { keyword, page, perPage, subjectType },
      headers: {
        "X-Forwarded-For": clientIp || void 0,
        "X-Real-IP": clientIp || void 0
      }
    });
    const content = processApiResponse(data);
    if (subjectType !== SubjectType.ALL && content.items) {
      content.items = content.items.filter((item) => item.subjectType === subjectType);
    }
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
