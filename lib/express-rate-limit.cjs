/**
 * express-rate-limit factories (apii / index dev).
 */
const rateLimit = require("express-rate-limit");
const { RATE_LIMITS, RATE_LIMIT_MESSAGE } = require("./rate-limit.cjs");
const { rateLimitKeyFromExpress } = require("./api-auth.cjs");

function createLimiter(bucket, corsHeaders = {}) {
  const cfg = RATE_LIMITS[bucket] || RATE_LIMITS.browse;
  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => rateLimitKeyFromExpress(req),
    handler: (req, res) => {
      res.set(corsHeaders);
      res.status(429).json({ status: "error", message: RATE_LIMIT_MESSAGE });
    }
  });
}

module.exports = { createLimiter };
