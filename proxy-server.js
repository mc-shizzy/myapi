/**
 * MovieBox stream proxy — Northflank / VPS (apii.freehandyflix.online)
 * Routes: GET /health, /api/search/:query,
 *   /api/search-suggest/:query, /api/popular-searches, /api/recommend/:movieId,
 *   /api/download/*, /api/subtitles/*
 */
const express = require("express");
const apiCore = require("./lib/api-handlers.cjs");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 7861;

const FMOVIES_ORIGIN = "https://fmoviesunblocked.net";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range"
};

const SPOOFER_IPS = [
  "196.207.55.12", "196.207.32.10", "196.207.128.50", "196.207.64.30",
  "41.90.64.100", "41.90.100.50", "41.90.200.25",
  "105.163.0.42", "105.163.100.20", "105.163.156.10",
  "41.215.130.10", "41.215.160.50",
  "196.216.0.20", "196.216.2.100",
  "102.0.0.30", "102.0.4.50",
  "41.89.4.10", "41.76.180.20", "197.248.0.50"
];

function getRandomIP() {
  return SPOOFER_IPS[Math.floor(Math.random() * SPOOFER_IPS.length)];
}

function isBenignStreamError(err) {
  if (!err) return true;
  if (err.name === "AbortError") return true;
  const code = err.code;
  const msg = String(err.message || "");
  if (code === "ABORT_ERR" || code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECANCELED") return true;
  if (msg === "terminated" || /aborted|closed prematurely|socket/i.test(msg)) return true;
  const c = err.cause;
  if (c && (c.code === "UND_ERR_SOCKET" || /closed|reset/i.test(String(c.message || "")))) return true;
  return false;
}

async function pipeUpstreamBody(req, res, upstreamResponse) {
  const body = upstreamResponse.body;
  if (!body) return res.end();
  const readable = Readable.fromWeb(body);
  readable.once("error", () => {});
  const onClientGone = () => readable.destroy();
  const onResClose = () => {
    if (!res.writableFinished) onClientGone();
  };
  req.once("aborted", onClientGone);
  res.once("close", onResClose);
  try {
    await pipeline(readable, res);
  } catch (err) {
    if (!isBenignStreamError(err)) throw err;
  } finally {
    req.removeListener("aborted", onClientGone);
    res.removeListener("close", onResClose);
  }
}

async function handleDownload(req, res) {
  const downloadUrl = decodeURIComponent(req.params[0]);
  if (
    !downloadUrl ||
    (!downloadUrl.startsWith("https://bcdnxw.hakunaymatata.com/") &&
      !downloadUrl.startsWith("https://valiw.hakunaymatata.com/"))
  ) {
    res.set(CORS_HEADERS);
    return res.status(400).json({ status: "error", message: "Invalid download URL" });
  }
  const ip = getRandomIP();
  const upstreamHeaders = {
    "User-Agent": "okhttp/4.12.0",
    Referer: `${FMOVIES_ORIGIN}/`,
    Origin: FMOVIES_ORIGIN,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
  const clientRange = req.headers["range"];
  if (clientRange) upstreamHeaders.Range = clientRange;
  try {
    const upstream = await fetch(downloadUrl, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      res.set(CORS_HEADERS);
      return res.status(502).json({ status: "error", message: `Upstream responded with ${upstream.status}` });
    }
    const responseHeaders = { ...CORS_HEADERS };
    responseHeaders["Content-Type"] = upstream.headers.get("content-type") || "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) responseHeaders["Content-Length"] = contentLength;
    responseHeaders["Content-Disposition"] = 'attachment; filename="movie.mp4"';
    responseHeaders["Accept-Ranges"] = "bytes";
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) responseHeaders["Content-Range"] = contentRange;
    res.set(responseHeaders);
    res.status(upstream.status);
    await pipeUpstreamBody(req, res, upstream);
  } catch (err) {
    if (isBenignStreamError(err)) return;
    if (!res.headersSent) {
      res.set(CORS_HEADERS);
      return res.status(502).json({ status: "error", message: err.message || "Stream failed" });
    }
    if (!res.writableEnded) res.destroy();
  }
}

async function handleSubtitles(req, res) {
  const subtitleUrl = decodeURIComponent(req.params[0]);
  if (!subtitleUrl || !subtitleUrl.startsWith("https://cacdn.hakunaymatata.com/")) {
    res.set(CORS_HEADERS);
    return res.status(400).json({ status: "error", message: "Invalid subtitle URL" });
  }
  const ip = getRandomIP();
  const upstreamHeaders = {
    "User-Agent": "okhttp/4.12.0",
    Referer: `${FMOVIES_ORIGIN}/`,
    Origin: FMOVIES_ORIGIN,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
  const clientRange = req.headers["range"];
  if (clientRange) upstreamHeaders.Range = clientRange;
  try {
    const upstream = await fetch(subtitleUrl, { headers: upstreamHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      res.set(CORS_HEADERS);
      return res.status(502).json({ status: "error", message: `Upstream responded with ${upstream.status}` });
    }
    const responseHeaders = { ...CORS_HEADERS };
    responseHeaders["Content-Type"] = upstream.headers.get("content-type") || "application/x-subrip";
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) responseHeaders["Content-Length"] = contentLength;
    responseHeaders["Content-Disposition"] = 'attachment; filename="subtitle.srt"';
    responseHeaders["Accept-Ranges"] = "bytes";
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) responseHeaders["Content-Range"] = contentRange;
    res.set(responseHeaders);
    res.status(upstream.status);
    await pipeUpstreamBody(req, res, upstream);
  } catch (err) {
    if (isBenignStreamError(err)) return;
    if (!res.headersSent) {
      res.set(CORS_HEADERS);
      return res.status(502).json({ status: "error", message: err.message || "Stream failed" });
    }
    if (!res.writableEnded) res.destroy();
  }
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.options("*", (req, res) => {
  res.set(CORS_HEADERS);
  return res.sendStatus(200);
});

app.get("/health", (req, res) => {
  res.set(CORS_HEADERS);
  return res.json({
    status: "ok",
    service: "moviebox-stream-proxy",
    publicUrl: process.env.PROXY_PUBLIC_URL || null,
    endpoints: [
      "GET /api/search/:query",
      "GET /api/search-suggest/:query",
      "GET /api/popular-searches",
      "GET /api/recommend/:movieId",
      "GET /api/download/*",
      "GET /api/subtitles/*"
    ]
  });
});

async function handleSearch(req, res) {
  const pageParam = parseInt(req.query.page, 10);
  const page = Number.isFinite(pageParam) ? pageParam : apiCore.SEARCH_DEFAULT_PAGE;
  const perPage = parseInt(req.query.perPage, 10) || apiCore.SEARCH_DEFAULT_PER_PAGE;
  const subjectType = parseInt(req.query.type, 10) || apiCore.SubjectType.ALL;
  const keyword = decodeURIComponent(req.params.query);
  const payload = await apiCore.search(keyword, page, perPage, subjectType);
  res.set({
    ...CORS_HEADERS,
    "Cache-Control": "private, max-age=300"
  });
  return res.json(payload);
}

async function handleSearchSuggest(req, res) {
  const keyword = decodeURIComponent(req.params.query);
  const perPage = parseInt(req.query.perPage, 10) || apiCore.SUGGEST_DEFAULT_PER_PAGE;
  const payload = await apiCore.getSearchSuggest(keyword, perPage);
  res.set({ ...CORS_HEADERS, "Cache-Control": `private, max-age=${apiCore.CACHE_TTLS.suggest}` });
  return res.json(payload);
}

async function handlePopularSearches(req, res) {
  const payload = await apiCore.getPopularSearches();
  res.set({ ...CORS_HEADERS, "Cache-Control": `public, max-age=${apiCore.CACHE_TTLS.popular}` });
  return res.json(payload);
}

async function handleRecommend(req, res) {
  const pageParam = parseInt(req.query.page, 10);
  const page = Number.isFinite(pageParam) ? pageParam : apiCore.SEARCH_DEFAULT_PAGE;
  const perPage = parseInt(req.query.perPage, 10) || apiCore.RECOMMEND_DEFAULT_PER_PAGE;
  const payload = await apiCore.getRecommend(req.params.movieId, page, perPage);
  res.set({ ...CORS_HEADERS, "Cache-Control": `public, max-age=${apiCore.CACHE_TTLS.recommend}` });
  return res.json(payload);
}

app.get("/api/search/:query", asyncHandler(handleSearch));
app.get("/api/search-suggest/:query", asyncHandler(handleSearchSuggest));
app.get("/api/popular-searches", asyncHandler(handlePopularSearches));
app.get("/api/recommend/:movieId", asyncHandler(handleRecommend));
app.get("/api/download/*", asyncHandler(handleDownload));
app.get("/api/subtitles/*", asyncHandler(handleSubtitles));

app.use((req, res) => {
  res.set(CORS_HEADERS);
  return res.status(404).json({
    status: "error",
    message: "Endpoint not found",
    availableEndpoints: [
      "GET /health",
      "GET /api/search/:query",
      "GET /api/search-suggest/:query",
      "GET /api/popular-searches",
      "GET /api/recommend/:movieId",
      "GET /api/download/*",
      "GET /api/subtitles/*"
    ]
  });
});

app.use((err, req, res, _next) => {
  res.set(CORS_HEADERS);
  return res.status(500).json({ status: "error", message: err.message });
});

app.listen(PORT, () => {
  console.log(`MovieBox stream proxy on http://localhost:${PORT}`);
  if (process.env.PROXY_PUBLIC_URL) {
    console.log(`Public URL: ${process.env.PROXY_PUBLIC_URL}`);
  }
});
