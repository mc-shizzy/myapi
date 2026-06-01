/**
 * API key (server-to-server) + signed stream tokens (browser playback).
 * Set API_KEY in env on apii and on callers (Northflank backend, Cloudflare Worker).
 */
const crypto = require("node:crypto");

const STREAM_TOKEN_TTL_SEC = 4 * 60 * 60; // 4h per playback session

function getApiKey(override) {
  const key = override ?? process.env.API_KEY ?? "";
  return String(key).trim();
}

function isAuthEnabled(override) {
  return getApiKey(override).length > 0;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractApiKeyFromHeaders(headers) {
  if (!headers) return "";
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name) || "";
    const lower = name.toLowerCase();
    return headers[lower] || headers[name] || "";
  };
  const auth = get("Authorization");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return get("X-Api-Key").trim();
}

function extractApiKeyFromExpress(req) {
  const auth = req.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.get("x-api-key") || "").trim();
}

function isValidApiKey(key, override) {
  const expected = getApiKey(override);
  if (!expected) return true;
  if (!key) return false;
  return timingSafeEqualStr(key, expected);
}

function getProxyAuthHeaders(override) {
  const key = getApiKey(override);
  if (!key) return {};
  return { "X-Api-Key": key };
}

function signStreamToken(encodedPath, override) {
  const secret = getApiKey(override);
  const exp = Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_SEC;
  const payload = `${exp}:${encodedPath}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { exp, sig };
}

function verifyStreamToken(encodedPath, exp, sig, override) {
  if (!isAuthEnabled(override)) return true;
  const secret = getApiKey(override);
  const expNum = parseInt(String(exp), 10);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  if (!sig || typeof sig !== "string") return false;
  const payload = `${expNum}:${encodedPath}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeEqualStr(sig, expected);
}

function appendStreamTokenToProxyUrl(proxyUrl, encodedPath, override) {
  if (!isAuthEnabled(override)) return proxyUrl;
  const { exp, sig } = signStreamToken(encodedPath, override);
  const url = new URL(proxyUrl);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

function requireApiKeyExpressMiddleware(corsHeaders) {
  return (req, res, next) => {
    if (!isAuthEnabled()) return next();
    if (req.path === "/health") return next();

    const apiKey = extractApiKeyFromExpress(req);
    const isStream =
      req.path.startsWith("/api/download") || req.path.startsWith("/api/subtitles");

    if (isStream) {
      const encoded = req.params[0] || "";
      if (verifyStreamToken(encoded, req.query.exp, req.query.sig)) return next();
      if (isValidApiKey(apiKey)) return next();
    } else if (isValidApiKey(apiKey)) {
      return next();
    }

    res.set(corsHeaders);
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  };
}

/** Rate-limit key: real client IP when trusted backend forwards it with valid API key. */
function rateLimitKeyFromExpress(req) {
  const apiKey = extractApiKeyFromExpress(req);
  if (isValidApiKey(apiKey)) {
    const fwd = req.get("x-forwarded-for");
    if (fwd) {
      const ip = fwd.split(",")[0].trim();
      if (ip) return ip;
    }
    const realIp = req.get("x-real-ip");
    if (realIp) return realIp.trim();
  }
  return req.ip || "unknown";
}

module.exports = {
  STREAM_TOKEN_TTL_SEC,
  getApiKey,
  isAuthEnabled,
  extractApiKeyFromHeaders,
  extractApiKeyFromExpress,
  isValidApiKey,
  getProxyAuthHeaders,
  signStreamToken,
  verifyStreamToken,
  appendStreamTokenToProxyUrl,
  requireApiKeyExpressMiddleware,
  rateLimitKeyFromExpress
};
