const { rateLimit } = require('express-rate-limit');
const config = require('../../../config/config');

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded[0]) {
        return String(forwarded[0]).trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimitHandler(req, res) {
    const payload = messages.too_many_request();
    if (typeof res.reply === 'function') {
        return res.reply(payload, {});
    }
    return res.status(payload.code).json({ message: payload.message, data: {} });
}

function createRateLimiter({ windowMs, max, skip }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIp,
        skip: skip || (() => !config.RATE_LIMIT_ENABLED),
        handler: rateLimitHandler,
    });
}

/** All /api/v1 routes — per-IP flood protection. */
const globalApiLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
});

/** Auth routes (OTP, login, profile upload) — tighter per-IP cap. */
const authApiLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_AUTH_WINDOW_MS,
    max: config.RATE_LIMIT_AUTH_MAX,
});

/** Public read endpoints (passport, FAQs) — moderate per-IP cap. */
const publicApiLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_PUBLIC_WINDOW_MS,
    max: config.RATE_LIMIT_PUBLIC_MAX,
    skip: (req) => !config.RATE_LIMIT_ENABLED || req.method !== 'GET',
});

module.exports = {
    globalApiLimiter,
    authApiLimiter,
    publicApiLimiter,
};
