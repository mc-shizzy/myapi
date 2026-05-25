const express = require("express");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 7860;

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
  memoryCache.set(key, { data, expiry: Date.now() + maxAgeSeconds * 1000 });
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

function processApiResponse(data) {
  if (data && data.data) return data.data;
  return data;
}

async function fetchSessionCookie() {
  try {
    const host = getRandomHost();
    const response = await fetch(
      `https://${host}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: buildHeaders(host) }
    );
    return response.headers.get("set-cookie") || "";
  } catch {
    return "";
  }
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
  res.set({ ...CORS_HEADERS, "Cache-Control": "public, s-maxage=60" });
  return res.json(APP_CONFIG);
}

async function handleApiHomepage(req, res) {
  const cacheKey = "homepage";
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set(CORS_HEADERS);
    return res.json(cached);
  }
  const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/home`);
  const payload = { status: "success", data: processApiResponse(data) };
  cacheSet(cacheKey, payload, 43200);
  res.set(CORS_HEADERS);
  return res.json(payload);
}

async function handleTrending(req, res) {
  const page = parseInt(req.query.page) || 0;
  const perPage = parseInt(req.query.perPage) || 18;
  const cacheKey = `trending_${page}_${perPage}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set(CORS_HEADERS);
    return res.json(cached);
  }
  const apiUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/trending`);
  apiUrl.searchParams.set("page", page);
  apiUrl.searchParams.set("perPage", perPage);
  apiUrl.searchParams.set("uid", "5591179548772780352");
  const data = await makeApiRequest(apiUrl.toString());
  const payload = { status: "success", data: processApiResponse(data) };
  cacheSet(cacheKey, payload, 10800);
  res.set(CORS_HEADERS);
  return res.json(payload);
}

async function handleSearch(req, res) {
  const encodedQuery = req.params.query;
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 24;
  const subjectType = parseInt(req.query.type) || SubjectType.ALL;
  const data = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/subject/search`, {
    method: "POST",
    body: {
      keyword: decodeURIComponent(encodedQuery),
      page,
      perPage,
      subjectType
    },
    headers: {
      "X-Forwarded-For": void 0,
      "X-Real-IP": void 0
    }
  });
  let content = processApiResponse(data);
  if (subjectType !== SubjectType.ALL && content.items) {
    content.items = content.items.filter((item) => item.subjectType === subjectType);
  }
  if (content.items) {
    content.items.forEach((item) => {
      if (item.cover && item.cover.url) item.thumbnail = item.cover.url;
      if (item.stills && item.stills.url && !item.thumbnail) item.thumbnail = item.stills.url;
    });
  }
  res.set(CORS_HEADERS);
  return res.json({ status: "success", data: content });
}

async function handleInfo(req, res) {
  const movieId = req.params.movieId;
  const apiUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`);
  apiUrl.searchParams.set("subjectId", movieId);
  const data = await makeApiRequest(apiUrl.toString());
  const content = processApiResponse(data);
  if (content.subject) {
    if (content.subject.cover && content.subject.cover.url) {
      content.subject.thumbnail = content.subject.cover.url;
    }
    if (content.subject.stills && content.subject.stills.url && !content.subject.thumbnail) {
      content.subject.thumbnail = content.subject.stills.url;
    }
  }
  res.set(CORS_HEADERS);
  return res.json({ status: "success", data: content });
}

/** Normal when clients seek, close the tab, or CDNs close idle sockets mid-stream — not an app bug. */
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
  if (!body) {
    return res.end();
  }
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

async function handleSources(req, res) {
  const movieId = req.params.movieId;
  const workerOrigin = getWorkerOrigin(req);
  const season = parseInt(req.query.season) || 0;
  const episode = parseInt(req.query.episode) || 0;
  const infoUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`);
  infoUrl.searchParams.set("subjectId", movieId);
  const infoData = await makeApiRequest(infoUrl.toString());
  const movieInfo = processApiResponse(infoData);
  const detailPath = movieInfo?.subject?.detailPath;
  if (!detailPath) {
    throw new Error("Could not get movie detail path for Referer header");
  }
  const refererUrl = `${FMOVIES_ORIGIN}/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`;
  const sourcesUrl = new URL(`${HOST_URL}/wefeed-h5-bff/web/subject/download`);
  sourcesUrl.searchParams.set("subjectId", movieId);
  sourcesUrl.searchParams.set("se", season);
  sourcesUrl.searchParams.set("ep", episode);
  const data = await makeApiRequest(sourcesUrl.toString(), {
    headers: {
      "Referer": refererUrl,
      "Origin": FMOVIES_ORIGIN
    }
  });
  const content = processApiResponse(data);
  if (content && content.downloads) {
    content.processedSources = content.downloads.map((file) => ({
      id: file.id,
      quality: file.resolution || "Unknown",
      directUrl: file.url,
      proxyUrl: `${workerOrigin}/api/download/${encodeURIComponent(file.url)}`,
      size: file.size,
      format: "mp4"
    }));
  }
  if (content && content.captions && content.captions.length > 0) {
    content.processedSubtitles = content.captions.map((cap) => ({
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
  res.set(CORS_HEADERS);
  return res.json({ status: "success", data: content });
}

async function handleDownload(req, res) {
  const downloadUrl = decodeURIComponent(req.params[0]);
  if (!downloadUrl || (!downloadUrl.startsWith("https://bcdnxw.hakunaymatata.com/") && !downloadUrl.startsWith("https://valiw.hakunaymatata.com/"))) {
    res.set(CORS_HEADERS);
    return res.status(400).json({ status: "error", message: "Invalid download URL" });
  }
  const ip = getRandomIP();
  const upstreamHeaders = {
    "User-Agent": "okhttp/4.12.0",
    "Referer": `${FMOVIES_ORIGIN}/`,
    "Origin": FMOVIES_ORIGIN,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
  const clientRange = req.headers["range"];
  if (clientRange) {
    upstreamHeaders["Range"] = clientRange;
  }
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
    "Referer": `${FMOVIES_ORIGIN}/`,
    "Origin": FMOVIES_ORIGIN,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
  const clientRange = req.headers["range"];
  if (clientRange) {
    upstreamHeaders["Range"] = clientRange;
  }
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

function handleRootPage(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MovieBox API \u2014 Documentation</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        :root{--bg:#0d1117;--card:#161b22;--border:#30363d;--accent:#58a6ff;--accent2:#3fb950;--accent3:#d2a8ff;--accent4:#f78166;--text:#c9d1d9;--text2:#8b949e;--white:#f0f6fc;}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;min-height:100vh;}
        a{color:var(--accent);text-decoration:none;}
        a:hover{text-decoration:underline;}
        code{background:rgba(110,118,129,0.2);padding:2px 6px;border-radius:4px;font-size:0.88em;font-family:'SF Mono',Consolas,monospace;color:var(--accent3);}

        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;justify-content:center;align-items:center;z-index:1000;backdrop-filter:blur(8px);}
        .login-modal{background:var(--card);border:1px solid var(--border);padding:40px;border-radius:16px;max-width:420px;width:90%;text-align:center;}
        .login-modal h2{color:var(--white);margin-bottom:8px;font-size:1.6em;}
        .login-modal .subtitle{color:var(--text2);margin-bottom:24px;font-size:0.95em;}
        .passcode-input{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--bg);color:var(--white);margin-bottom:16px;transition:border-color 0.2s;}
        .passcode-input:focus{outline:none;border-color:var(--accent);}
        .login-btn{background:var(--accent);color:var(--bg);border:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%;transition:opacity 0.2s;}
        .login-btn:hover{opacity:0.85;}
        .error-message{color:#f85149;margin-top:12px;font-size:13px;display:none;}

        .wrapper{max-width:960px;margin:0 auto;padding:32px 20px;}
        .hidden{display:none;}

        .hero{text-align:center;padding:48px 24px;border-bottom:1px solid var(--border);margin-bottom:32px;}
        .hero h1{font-size:2.4em;color:var(--white);margin-bottom:8px;font-weight:800;letter-spacing:-0.5px;}
        .hero p{color:var(--text2);font-size:1.15em;max-width:550px;margin:0 auto;}
        .badge-row{display:flex;gap:8px;justify-content:center;margin-top:20px;flex-wrap:wrap;}
        .badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:20px;font-size:0.78em;font-weight:600;border:1px solid var(--border);}
        .badge.green{color:var(--accent2);border-color:rgba(63,185,80,0.3);background:rgba(63,185,80,0.08);}
        .badge.blue{color:var(--accent);border-color:rgba(88,166,255,0.3);background:rgba(88,166,255,0.08);}
        .badge.purple{color:var(--accent3);border-color:rgba(210,168,255,0.3);background:rgba(210,168,255,0.08);}

        .features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:40px;}
        .feat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;}
        .feat .icon{font-size:1.5em;margin-bottom:8px;}
        .feat h4{color:var(--white);margin-bottom:4px;font-size:0.95em;}
        .feat p{color:var(--text2);font-size:0.82em;line-height:1.5;}

        .section{margin-bottom:40px;}
        .section-title{color:var(--white);font-size:1.4em;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border);font-weight:700;}

        .ep{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:16px;transition:border-color 0.2s;}
        .ep:hover{border-color:var(--accent);}
        .ep-header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
        .method{background:rgba(63,185,80,0.15);color:var(--accent2);padding:3px 10px;border-radius:6px;font-size:0.75em;font-weight:700;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.5px;}
        .ep-path{color:var(--white);font-family:'SF Mono',Consolas,monospace;font-size:0.95em;font-weight:600;}
        .ep p{color:var(--text2);margin-bottom:10px;font-size:0.9em;}
        .ep-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
        .try-link{display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border-radius:6px;font-size:0.82em;font-weight:500;background:rgba(88,166,255,0.1);color:var(--accent);border:1px solid rgba(88,166,255,0.25);transition:background 0.2s;}
        .try-link:hover{background:rgba(88,166,255,0.2);text-decoration:none;}

        .code-block{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0;overflow-x:auto;font-family:'SF Mono',Consolas,monospace;font-size:0.82em;line-height:1.7;color:var(--text);}
        .code-block .cm{color:var(--text2);}
        .code-block .str{color:var(--accent2);}
        .code-block .key{color:var(--accent3);}
        .code-block .kw{color:#ff7b72;}

        .info-box{border-radius:10px;padding:16px 20px;margin:16px 0;font-size:0.88em;line-height:1.6;border:1px solid;}
        .info-box.tip{background:rgba(63,185,80,0.06);border-color:rgba(63,185,80,0.25);color:var(--accent2);}
        .info-box.warn{background:rgba(210,168,255,0.06);border-color:rgba(210,168,255,0.25);color:var(--accent3);}
        .info-box.compat{background:rgba(88,166,255,0.06);border-color:rgba(88,166,255,0.25);color:var(--accent);}
        .info-box strong{color:var(--white);}

        .faq{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:12px;}
        .faq h4{color:var(--white);margin-bottom:6px;font-size:0.95em;}
        .faq p{color:var(--text2);font-size:0.88em;line-height:1.6;}

        .footer{text-align:center;padding:32px 20px;border-top:1px solid var(--border);margin-top:48px;color:var(--text2);font-size:0.85em;}
        .footer strong{color:var(--white);}

        .nav{display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:0;overflow-x:auto;}
        .nav-tab{padding:10px 18px;color:var(--text2);font-size:0.88em;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;transition:color 0.2s,border-color 0.2s;white-space:nowrap;}
        .nav-tab:hover{color:var(--white);}
        .nav-tab.active{color:var(--white);border-bottom-color:var(--accent4);}
        .tab-content{display:none;}
        .tab-content.active{display:block;}

        @media(max-width:600px){
            .hero h1{font-size:1.8em;}
            .wrapper{padding:20px 14px;}
            .ep{padding:16px;}
            .features-grid{grid-template-columns:1fr;}
        }
    </style>
</head>
<body>
    <div id="loginModal" class="modal-overlay">
        <div class="login-modal">
            <h2>\u{1F512} MovieBox API</h2>
            <p class="subtitle">Enter the passcode to access documentation</p>
            <input type="password" id="passcodeInput" class="passcode-input" placeholder="Passcode..." autocomplete="off">
            <button id="loginBtn" class="login-btn">Unlock</button>
            <div id="errorMessage" class="error-message">Invalid passcode. Try again.</div>
        </div>
    </div>

    <div id="mainContent" class="hidden">
        <div class="wrapper">
            <div class="hero">
                <h1>\u{1F3AC} MovieBox API</h1>
                <p>Stream movies &amp; TV series with full subtitle support, video seeking, and download pause/resume</p>
                <div class="badge-row">
                    <span class="badge green">\u2713 8 Endpoints</span>
                    <span class="badge blue">\u2713 Video Seeking</span>
                    <span class="badge purple">\u2713 Subtitles</span>
                    <span class="badge green">\u2713 Pause/Resume</span>
                </div>
            </div>

            <div class="features-grid">
                <div class="feat"><div class="icon">\u{1F50D}</div><h4>Search</h4><p>Search movies &amp; TV series from MovieBox database with live results</p></div>
                <div class="feat"><div class="icon">\u{1F4E5}</div><h4>Multi-Quality</h4><p>Download links in 360p, 480p, 720p, and 1080p</p></div>
                <div class="feat"><div class="icon">\u{1F5D2}\uFE0F</div><h4>Subtitles</h4><p>Multiple languages in SRT format with proxy support</p></div>
                <div class="feat"><div class="icon">\u23E9</div><h4>Video Seeking</h4><p>HTTP Range support \u2014 skip to any position in the video</p></div>
                <div class="feat"><div class="icon">\u23F8\uFE0F</div><h4>Pause/Resume</h4><p>Pause downloads and resume where you left off</p></div>
                <div class="feat"><div class="icon">\u{1F30D}</div><h4>Region Bypass</h4><p>Built-in rotation with ${SPOOFER_IPS.length} Kenyan IPs for unrestricted access</p></div>
            </div>

            <div class="nav">
                <div class="nav-tab active" data-tab="endpoints">Endpoints</div>
                <div class="nav-tab" data-tab="subtitles">Subtitles Guide</div>
                <div class="nav-tab" data-tab="streaming">Streaming &amp; Seeking</div>
                <div class="nav-tab" data-tab="faq">FAQ</div>
            </div>

            <div id="tab-endpoints" class="tab-content active">
                <div class="section">
                    <div class="section-title">Core Endpoints</div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/search/:query</span></div>
                        <p>Search for movies and TV series. Returns titles, IDs, posters, year, rating, and available subtitle languages.</p>
                        <div class="ep-links">
                            <a href="/api/search/avatar" class="try-link">\u2192 avatar</a>
                            <a href="/api/search/spider-man" class="try-link">\u2192 spider-man</a>
                            <a href="/api/search/wednesday" class="try-link">\u2192 wednesday</a>
                        </div>
                    </div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/info/:movieId</span></div>
                        <p>Detailed movie/series information \u2014 cast, description, ratings, seasons, episodes, and metadata.</p>
                        <div class="ep-links">
                            <a href="/api/info/8906247916759695608" class="try-link">\u2192 Avatar</a>
                            <a href="/api/info/3815343854912427320" class="try-link">\u2192 Spider-Man</a>
                            <a href="/api/info/9028867555875774472" class="try-link">\u2192 Wednesday</a>
                        </div>
                    </div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/sources/:movieId</span></div>
                        <p>Get download links (direct + proxy URLs) in multiple qualities, plus <code>captions</code> and <code>processedSubtitles</code>.</p>
                        <p>For TV episodes, add <code>?season=1&amp;episode=1</code> query parameters.</p>
                        <div class="ep-links">
                            <a href="/api/sources/8906247916759695608" class="try-link">\u2192 Avatar (movie)</a>
                            <a href="/api/sources/9028867555875774472?season=1&episode=1" class="try-link">\u2192 Wednesday S1E1</a>
                            <a href="/api/sources/9028867555875774472?season=1&episode=3" class="try-link">\u2192 Wednesday S1E3</a>
                        </div>
                    </div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/homepage</span></div>
                        <p>Homepage content \u2014 featured movies, recommendations, and categories from MovieBox.</p>
                        <div class="ep-links"><a href="/api/homepage" class="try-link">\u2192 View Homepage</a></div>
                    </div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/trending</span></div>
                        <p>Currently trending movies and TV series. Supports <code>?page=0&amp;perPage=18</code> pagination.</p>
                        <div class="ep-links"><a href="/api/trending" class="try-link">\u2192 View Trending</a></div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-title">Proxy Endpoints</div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/download/:encodedUrl</span></div>
                        <p>Video download proxy \u2014 bypasses CDN restrictions with proper headers. <strong>Supports HTTP Range requests</strong> for video seeking and download pause/resume.</p>
                        <p>URLs are provided automatically in the <code>/api/sources</code> response as <code>proxyUrl</code>.</p>
                        <div class="info-box tip">
                            <strong>\u2713 Video Seeking:</strong> Send a <code>Range</code> header and get <code>206 Partial Content</code> back \u2014 your video player can skip to any position.<br>
                            <strong>\u2713 Pause/Resume:</strong> Stop a download, then resume later by requesting the remaining byte range.
                        </div>
                    </div>

                    <div class="ep">
                        <div class="ep-header"><span class="method">GET</span><span class="ep-path">/api/subtitles/:encodedUrl</span></div>
                        <p>Subtitle proxy \u2014 serves <code>.srt</code> files through the proxy with proper CDN headers. Also supports Range requests.</p>
                        <p>URLs are provided in the <code>/api/sources</code> response under <code>processedSubtitles[].proxyUrl</code>.</p>
                    </div>
                </div>
            </div>

            <div id="tab-subtitles" class="tab-content">
                <div class="section">
                    <div class="section-title">How Subtitles Work</div>

                    <p style="color:var(--text2);margin-bottom:16px;">Subtitles are returned automatically when you call the <code>/api/sources/:movieId</code> endpoint. You get them in two formats:</p>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">1. Raw Captions \u2014 <code>captions</code> array</h4>
                        <p>The original caption data from the upstream API.</p>
                        <div class="code-block">
<span class="cm">// Inside /api/sources response \u2192 data.captions</span>
[
  {
    <span class="key">"id"</span>: <span class="str">"4450709968790113000"</span>,
    <span class="key">"lan"</span>: <span class="str">"en"</span>,
    <span class="key">"lanName"</span>: <span class="str">"English"</span>,
    <span class="key">"url"</span>: <span class="str">"https://cacdn.hakunaymatata.com/subtitle/...srt"</span>,
    <span class="key">"size"</span>: <span class="str">"116641"</span>,
    <span class="key">"delay"</span>: 0
  }
]</div>
                    </div>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">2. Processed Subtitles \u2014 <code>processedSubtitles</code> array</h4>
                        <p>Enhanced version with proxy URLs ready to use. <strong>This is what you should use in your app/website.</strong></p>
                        <div class="code-block">
<span class="cm">// Inside /api/sources response \u2192 data.processedSubtitles</span>
[
  {
    <span class="key">"id"</span>: <span class="str">"4450709968790113000"</span>,
    <span class="key">"languageCode"</span>: <span class="str">"en"</span>,
    <span class="key">"languageName"</span>: <span class="str">"English"</span>,
    <span class="key">"directUrl"</span>: <span class="str">"https://cacdn.hakunaymatata.com/..."</span>,
    <span class="key">"proxyUrl"</span>: <span class="str">"https://your-api.com/api/subtitles/https%3A%2F%2Fcacdn..."</span>,
    <span class="key">"size"</span>: <span class="str">"116641"</span>,
    <span class="key">"delay"</span>: 0,
    <span class="key">"format"</span>: <span class="str">"srt"</span>
  }
]</div>
                    </div>

                    <div class="section-title" style="margin-top:32px;">Using Subtitles in Your App</div>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">HTML5 Video Player</h4>
                        <div class="code-block">
<span class="cm">&lt;!-- Use proxyUrl from processedSubtitles --&gt;</span>
&lt;<span class="kw">video</span> controls&gt;
  &lt;<span class="kw">source</span> src=<span class="str">"YOUR_PROXY_VIDEO_URL"</span> type=<span class="str">"video/mp4"</span>&gt;
  &lt;<span class="kw">track</span>
    kind=<span class="str">"subtitles"</span>
    src=<span class="str">"PROXY_SUBTITLE_URL"</span>
    srclang=<span class="str">"en"</span>
    label=<span class="str">"English"</span>
    default&gt;
  &lt;<span class="kw">track</span>
    kind=<span class="str">"subtitles"</span>
    src=<span class="str">"PROXY_SUBTITLE_URL_FR"</span>
    srclang=<span class="str">"fr"</span>
    label=<span class="str">"Fran\u00e7ais"</span>&gt;
&lt;/<span class="kw">video</span>&gt;</div>
                    </div>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">JavaScript / Fetch Example</h4>
                        <div class="code-block">
<span class="cm">// Step 1: Get sources + subtitles</span>
<span class="kw">const</span> res = <span class="kw">await</span> fetch(<span class="str">'/api/sources/8906247916759695608'</span>);
<span class="kw">const</span> { data } = <span class="kw">await</span> res.json();

<span class="cm">// Step 2: Get video proxy URL</span>
<span class="kw">const</span> videoUrl = data.processedSources[0].proxyUrl;

<span class="cm">// Step 3: Get subtitles</span>
data.processedSubtitles.forEach(sub =&gt; {
  console.log(sub.languageName, sub.proxyUrl);
  <span class="cm">// "English" \u2192 "/api/subtitles/https%3A%2F%2Fcacdn..."</span>
  <span class="cm">// "Fran\u00e7ais" \u2192 "/api/subtitles/https%3A%2F%2Fcacdn..."</span>
});</div>
                    </div>

                    <div class="info-box compat">
                        <strong>\u{1F512} Will subtitles break my website?</strong><br>
                        No! The subtitle data is <strong>additive</strong> \u2014 it's just new fields added to the <code>/api/sources</code> response. Your existing code that reads <code>processedSources</code> or downloads won't be affected. The <code>processedSubtitles</code> and <code>captions</code> fields are simply new data you can choose to use or ignore.
                    </div>
                </div>
            </div>

            <div id="tab-streaming" class="tab-content">
                <div class="section">
                    <div class="section-title">Video Seeking &amp; Download Pause/Resume</div>

                    <p style="color:var(--text2);margin-bottom:16px;">The <code>/api/download/*</code> proxy endpoint supports <strong>HTTP Range requests</strong>. This is the standard protocol used by video players and download managers.</p>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">How It Works</h4>
                        <p>When you play a video through the proxy URL, the browser/player sends requests like:</p>
                        <div class="code-block">
<span class="cm"># Normal request \u2014 full file</span>
GET /api/download/https%3A%2F%2Fbcdnxw... HTTP/1.1

<span class="cm"># Response</span>
HTTP/1.1 <span class="str">200 OK</span>
Accept-Ranges: <span class="str">bytes</span>
Content-Length: <span class="str">623914683</span>

<span class="cm"># Seeking to 50% \u2014 player sends Range header</span>
GET /api/download/https%3A%2F%2Fbcdnxw... HTTP/1.1
Range: <span class="str">bytes=311957341-</span>

<span class="cm"># Response \u2014 partial content</span>
HTTP/1.1 <span class="str">206 Partial Content</span>
Accept-Ranges: <span class="str">bytes</span>
Content-Range: <span class="str">bytes 311957341-623914682/623914683</span>
Content-Length: <span class="str">311957342</span></div>
                    </div>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">Video Seeking in a Player</h4>
                        <p>Just use the <code>proxyUrl</code> from the sources response as the video source. Seeking works automatically \u2014 the browser handles Range requests.</p>
                        <div class="code-block">
<span class="cm">&lt;!-- This just works \u2014 seeking is automatic --&gt;</span>
&lt;<span class="kw">video</span> controls src=<span class="str">"https://your-api.com/api/download/https%3A%2F%2F..."</span>&gt;
&lt;/<span class="kw">video</span>&gt;

<span class="cm">&lt;!-- Or with JavaScript --&gt;</span>
&lt;<span class="kw">script</span>&gt;
  <span class="kw">const</span> video = document.querySelector(<span class="str">'video'</span>);
  video.src = data.processedSources[0].proxyUrl;
  <span class="cm">// User can now drag the seek bar freely \u2713</span>
  <span class="cm">// Player auto-sends Range requests \u2713</span>
&lt;/<span class="kw">script</span>&gt;</div>
                    </div>

                    <div class="ep">
                        <h4 style="color:var(--white);margin-bottom:8px;">Download Pause/Resume</h4>
                        <p>Download managers and apps can pause and resume by requesting byte ranges:</p>
                        <div class="code-block">
<span class="cm"># Start download \u2014 get first 10MB</span>
curl -H <span class="str">"Range: bytes=0-10485759"</span> -o part1.mp4 <span class="str">PROXY_URL</span>

<span class="cm"># \u23F8\uFE0F Pause... then resume from where you stopped</span>
curl -H <span class="str">"Range: bytes=10485760-"</span> -o part2.mp4 <span class="str">PROXY_URL</span>

<span class="cm"># Combine</span>
cat part1.mp4 part2.mp4 &gt; full_movie.mp4</div>
                    </div>

                    <div class="info-box compat">
                        <strong>\u{1F504} Do I need to update my app/website?</strong><br>
                        <strong>No!</strong> If you are already using the <code>proxyUrl</code> from <code>/api/sources</code>, video seeking and pause/resume work <strong>automatically</strong>. The browser's <code>&lt;video&gt;</code> element and download managers already know how to send <code>Range</code> headers. The API now responds correctly to them \u2014 no code changes needed on your side.
                    </div>

                    <div class="info-box tip">
                        <strong>\u2713 Backward compatible:</strong> Requests without a <code>Range</code> header still return the full file with <code>200 OK</code>, just like before. Nothing breaks.
                    </div>
                </div>
            </div>

            <div id="tab-faq" class="tab-content">
                <div class="section">
                    <div class="section-title">Frequently Asked Questions</div>

                    <div class="faq">
                        <h4>Will the new changes break my existing website or app?</h4>
                        <p>No. All changes are <strong>backward compatible</strong>. The API still returns the same response structure \u2014 it just adds new fields (<code>processedSubtitles</code>, <code>captions</code>) and supports Range headers on proxy endpoints. Your existing code will continue to work without any modifications.</p>
                    </div>

                    <div class="faq">
                        <h4>Does video seeking work when streaming through the proxy?</h4>
                        <p>Yes! The <code>/api/download/*</code> proxy now forwards <code>Range</code> headers to the upstream CDN and returns <code>206 Partial Content</code> with the correct <code>Content-Range</code>. Any standard video player (browser &lt;video&gt;, VLC, mobile apps) will be able to seek automatically.</p>
                    </div>

                    <div class="faq">
                        <h4>Can I pause and resume a download through the proxy?</h4>
                        <p>Yes. The proxy advertises <code>Accept-Ranges: bytes</code> and correctly handles partial requests. Download managers (IDM, wget -c, curl with Range headers) can pause and continue downloads.</p>
                    </div>

                    <div class="faq">
                        <h4>How do I add subtitles to my video player?</h4>
                        <p>Call <code>/api/sources/:id</code> and use the <code>processedSubtitles</code> array. Each entry has a <code>proxyUrl</code> you can use as a <code>&lt;track&gt;</code> source in HTML5 video, or load directly in your mobile app's subtitle renderer.</p>
                    </div>

                    <div class="faq">
                        <h4>What subtitle format is used?</h4>
                        <p>All subtitles are in <strong>SRT</strong> format. The <code>format</code> field in <code>processedSubtitles</code> confirms this. SRT is supported by virtually all video players.</p>
                    </div>

                    <div class="faq">
                        <h4>What languages are available for subtitles?</h4>
                        <p>It depends on the movie. Common languages include English, French, Spanish, Arabic, Indonesian (<code>in_id</code>), and many more. Check the <code>processedSubtitles</code> array for available options per title.</p>
                    </div>

                    <div class="faq">
                        <h4>Do I need to use the proxy URL for subtitles?</h4>
                        <p>The <code>directUrl</code> may work in some cases, but it can be blocked by CDN restrictions. Using the <code>proxyUrl</code> (<code>/api/subtitles/...</code>) is recommended because it adds the proper headers to bypass CDN blocks.</p>
                    </div>
                </div>
            </div>

            <div class="footer">
                <strong>MovieBox API</strong> \u2014 All 8 endpoints operational<br>
                <span>Powered by Mr Frank x Sam \u00b7 Region bypass with ${SPOOFER_IPS.length} rotating Kenyan IPs \u00b7 Mobile auth headers</span>
            </div>
        </div>
    </div>

    <script>
        function validatePasscode(input) {
            const encodedPasscode = "ZGFyZXgxMjM=";
            return input === atob(encodedPasscode);
        }
        const loginModal = document.getElementById('loginModal');
        const mainContent = document.getElementById('mainContent');
        const passcodeInput = document.getElementById('passcodeInput');
        const loginBtn = document.getElementById('loginBtn');
        const errorMessage = document.getElementById('errorMessage');
        function handleLogin() {
            const passcode = passcodeInput.value.trim();
            if (validatePasscode(passcode)) {
                loginModal.style.display = 'none';
                mainContent.classList.remove('hidden');
                sessionStorage.setItem('authenticated', 'true');
            } else {
                errorMessage.style.display = 'block';
                passcodeInput.value = '';
                passcodeInput.focus();
            }
        }
        loginBtn.addEventListener('click', handleLogin);
        passcodeInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleLogin();
        });
        if (sessionStorage.getItem('authenticated') === 'true') {
            loginModal.style.display = 'none';
            mainContent.classList.remove('hidden');
        } else {
            setTimeout(() => passcodeInput.focus(), 100);
        }
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            });
        });
    <\/script>
</body>
</html>`;
  res.set({ ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" });
  return res.send(html);
}

// ─── CORS preflight ──────────────────────────────────────────────────────────

app.options("*", (req, res) => {
  res.set(CORS_HEADERS);
  return res.sendStatus(200);
});

// ─── Async error wrapper ─────────────────────────────────────────────────────

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── Routes (same paths as the Worker) ───────────────────────────────────────

app.get("/", handleRootPage);
app.get("/api/config", handleAppConfig);
app.get("/api/homepage", asyncHandler(handleApiHomepage));
app.get("/api/trending", asyncHandler(handleTrending));
app.get("/api/search/:query", asyncHandler(handleSearch));
app.get("/api/info/:movieId", asyncHandler(handleInfo));
app.get("/api/sources/:movieId", asyncHandler(handleSources));
app.get("/api/download/*", asyncHandler(handleDownload));
app.get("/api/subtitles/*", asyncHandler(handleSubtitles));

// ─── 404 fallback ────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.set(CORS_HEADERS);
  return res.status(404).json({
    status: "error",
    message: "Endpoint not found",
    availableEndpoints: [
      "GET /",
      "GET /api/homepage",
      "GET /api/trending",
      "GET /api/search/:query",
      "GET /api/info/:movieId",
      "GET /api/sources/:movieId",
      "GET /api/download/*",
      "GET /api/subtitles/*"
    ]
  });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  res.set(CORS_HEADERS);
  return res.status(500).json({ status: "error", message: err.message });
});

// ─── Start server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`MovieBox API running on http://localhost:${PORT}`);
});
