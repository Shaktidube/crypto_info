require('dotenv').config();

const config = {
    NODE_ENV: process.env.NODE_ENV || 'dev',
    PORT: process.env.PORT || 4040,

    DB_URL: process.env.DB_URL || 'mongodb://localhost:27017/demo',

    JWT_VALIDITY: process.env.JWT_VALIDITY || '30d',
    /** Short-lived JWT when user does not opt in to “remember this device”. */
    JWT_VALIDITY_SHORT: process.env.JWT_VALIDITY_SHORT || '1d',
    /** Trusted-browser session length (days). */
    TRUSTED_DEVICE_SESSION_DAYS: 
    Number(process.env.TRUSTED_DEVICE_SESSION_DAYS) || 30,
    /** Require OTP again after this many days without a successful login on the device. */
    OTP_INACTIVITY_DAYS: Number(process.env.OTP_INACTIVITY_DAYS) || 30,
    TRUSTED_DEVICE_MAX_COUNT: 
    Number(process.env.TRUSTED_DEVICE_MAX_COUNT) || 10,
    /** Concurrent login sessions per user (phone + desktop, etc.). Oldest pruned when exceeded. */
    MAX_USER_SESSIONS: Number(process.env.MAX_USER_SESSIONS) || 20,
    JWT_SECRET: process.env.JWT_SECRET || 'cH@!nu5_sec',

    MAIL_TRANSPORTER: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        auth: {
            user: process.env.SMTP_USERNAME || 'example@gmail.com',
            pass: process.env.SMTP_PASSWORD || 'example@123',
        },
        secure: Number(process.env.SMTP_PORT) === 465,
    },
    SMTP_FROM: process.env.SMTP_FROM || 'example@gmail.com',
    WEB_URL: process.env.WEB_URL || 'http://localhost',
    /** Public frontend origin for passport OG pre-warm (no trailing slash). */
    FRONTEND_URL:
        process.env.FRONTEND_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.WEB_URL ||
        'http://localhost',
    /** Public origin for uploaded files (no trailing slash). Set on staging/prod. */
    BACKEND_PUBLIC_URL: process.env.BACKEND_PUBLIC_URL || process.env.API_PUBLIC_URL || '',
    SITE_NAME: process.env.SITE_NAME || 'Demo',

    S3_REGION: process.env.S3_REGION|| 'ap-south-1',
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME|| 'yudiz-blockchain',
    S3_BUCKET_SUB_NAME: process.env.S3_BUCKET_SUB_NAME?.trim() || '',
    S3_BUCKET_URL:
        process.env.S3_BUCKET_URL||
        'https://yudiz-blockchain.s3.ap-south-1.amazonaws.com',
    AWS_ACCESS_KEY:
        process.env.AWS_ACCESS_KEY?.trim() ||
        'your aws accessKey',
    AWS_SECRET_KEY:
        process.env.AWS_SECRET_KEY?.trim() ||
        'your aws secretAccessKey',
    /** Optional shared secret for Next.js → backend passport OG PNG uploads (not browser-facing). */
    PASSPORT_OG_UPLOAD_SECRET: process.env.PASSPORT_OG_UPLOAD_SECRET?.trim() || '',

    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

    KRAKEN_CLIENT_ID: process.env.KRAKEN_CLIENT_ID || '',
    KRAKEN_CLIENT_SECRET: process.env.KRAKEN_CLIENT_SECRET || '',
    KRAKEN_REDIRECT_URI: process.env.KRAKEN_REDIRECT_URI || '',
    // https://docs.kraken.com/api/docs/oauth/kraken-connect/
    KRAKEN_TOKEN_ENDPOINT:
        process.env.KRAKEN_TOKEN_ENDPOINT || 'https://api.kraken.com/oauth/token',

    COINDCX_API_KEY: process.env.COINDCX_API_KEY?.trim() || '',
    COINDCX_API_SECRET: process.env.COINDCX_API_SECRET?.trim() || '',
    COINDCX_FUTURES_MARGIN_CURRENCY:
        process.env.COINDCX_FUTURES_MARGIN_CURRENCY?.trim() || 'USDT',
    COINDCX_FUTURES_PAIRS: (process.env.COINDCX_FUTURES_PAIRS || '')
        .split(',').map((pair) => pair.trim()).filter(Boolean),
    /**
     * When COINDCX_FUTURES_PAIRS is empty, optionally cap instruments.
     * 0 = scan all active instruments (no cap).
     */
    COINDCX_MAX_INSTRUMENTS: (() => {
        const raw = process.env.COINDCX_MAX_INSTRUMENTS;
        if (raw == null || String(raw).trim() === '') return 0;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    })(),
    COINDCX_SCANNER_ENABLED: process.env.COINDCX_SCANNER_ENABLED === 'true',
    /** Book-aligned default: 1d. Also supports 4h and 1m. */
    COINDCX_SCANNER_TIMEFRAME:
        (process.env.COINDCX_SCANNER_TIMEFRAME || '1d').trim().toLowerCase(),
    /** Optional raw CoinDCX resolution override (e.g. 240, 1D). */
    COINDCX_RESOLUTION_OVERRIDE:
        process.env.COINDCX_RESOLUTION_OVERRIDE?.trim() || '',
    COINDCX_ACTIVE_MARKETS_REFRESH_MINUTES:
        Number(process.env.COINDCX_ACTIVE_MARKETS_REFRESH_MINUTES) || 60,
    /**
     * Leave empty to use the timeframe default cron
     * (1d → daily 00:00:05 UTC, 4h → every 4h, 1m → every minute).
     */
    COINDCX_CRON_SCHEDULE:
        process.env.COINDCX_CRON_SCHEDULE?.trim() || '',
    COINDCX_POLL_CONCURRENCY:
        Number(process.env.COINDCX_POLL_CONCURRENCY) || 5,
    COINDCX_POLL_LOOKBACK_MINUTES:
        Number(process.env.COINDCX_POLL_LOOKBACK_MINUTES) || 5,
    COINDCX_POLL_LOOKBACK_CANDLES:
        Number(process.env.COINDCX_POLL_LOOKBACK_CANDLES) || 0,
    COINDCX_HISTORY_CANDLE_COUNT:
        Number(process.env.COINDCX_HISTORY_CANDLE_COUNT) || 120,
    CANDLE_REQUIRE_CONFIRMATION:
        process.env.CANDLE_REQUIRE_CONFIRMATION !== 'false',
    CANDLE_MIN_IMPULSE_BODY_PERCENT:
        Number(process.env.CANDLE_MIN_IMPULSE_BODY_PERCENT) || 0.55,
    CANDLE_MIN_ATR_MULTIPLIER:
        Number(process.env.CANDLE_MIN_ATR_MULTIPLIER) || 0.60,
    CANDLE_MIN_VOLUME_MULTIPLIER:
        Number(process.env.CANDLE_MIN_VOLUME_MULTIPLIER) || 1.20,
    CANDLE_MAX_INNER_BODY_RATIO:
        Number(process.env.CANDLE_MAX_INNER_BODY_RATIO) || 0.50,
    CANDLE_BODY_TOLERANCE_PERCENT:
        Number(process.env.CANDLE_BODY_TOLERANCE_PERCENT) || 0.05,
    /**
     * Comma-separated pattern names the scanner may alert on.
     * Default keeps historical behavior: confirmed Bearish Harami only.
     * Set CANDLE_USE_ANALYSIS_ENGINE=true to route through the layered
     * candlestick engine (geometry → context → confirmation → score).
     */
    CANDLE_ENABLED_PATTERNS: (process.env.CANDLE_ENABLED_PATTERNS ||
        'Bearish Harami')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    CANDLE_USE_ANALYSIS_ENGINE:
        process.env.CANDLE_USE_ANALYSIS_ENGINE === 'true',
    CANDLE_REQUIRE_CONTEXT_MATCH:
        process.env.CANDLE_REQUIRE_CONTEXT_MATCH !== 'false',
    CANDLE_MIN_CONFIDENCE:
        Number(process.env.CANDLE_MIN_CONFIDENCE) || 0.35,
    /** Only alert on premium multi-candle setups with strong confirmation. */
    CANDLE_HIGH_QUALITY_ONLY:
        process.env.CANDLE_HIGH_QUALITY_ONLY !== 'false',
    CANDLE_MIN_CONFIRMATION_STRENGTH:
        Number(process.env.CANDLE_MIN_CONFIRMATION_STRENGTH) || 0.33,
    CANDLE_PREMIUM_PATTERNS_ONLY:
        process.env.CANDLE_PREMIUM_PATTERNS_ONLY !== 'false',
    CANDLE_MIN_PATTERN_CANDLES:
        Number(process.env.CANDLE_MIN_PATTERN_CANDLES) || 2,
    /**
     * Trade side filter: long | short | both
     * Empty / unset / both => long and short signals.
     */
    TRADE_SIDE_MODE: (() => {
        const value = String(process.env.TRADE_SIDE_MODE || '')
            .trim().toLowerCase();
        if (!value || value === 'both' || value === 'all' || value === 'any') {
            return 'both';
        }
        if (value === 'long' || value === 'buy' || value === 'bullish') {
            return 'long';
        }
        if (value === 'short' || value === 'sell' || value === 'bearish') {
            return 'short';
        }
        // eslint-disable-next-line no-console
        console.warn(
            `Invalid TRADE_SIDE_MODE "${process.env.TRADE_SIDE_MODE}", using both`,
        );
        return 'both';
    })(),
    /** Risk plan defaults (analytical — no auto trading). */
    /** Account sizing for analytical SL/TP/leverage plans. */
    TRADE_ACCOUNT_CURRENCY:
        (process.env.TRADE_ACCOUNT_CURRENCY || 'INR').trim().toUpperCase(),
    TRADE_ACCOUNT_BALANCE: Number(
        process.env.TRADE_ACCOUNT_BALANCE ||
        process.env.TRADE_ACCOUNT_BALANCE_USD ||
        2000,
    ),
    /** @deprecated use TRADE_ACCOUNT_BALANCE */
    TRADE_ACCOUNT_BALANCE_USD: Number(
        process.env.TRADE_ACCOUNT_BALANCE ||
        process.env.TRADE_ACCOUNT_BALANCE_USD ||
        2000,
    ),
    TRADE_RISK_PERCENT:
        Number(process.env.TRADE_RISK_PERCENT) || 1,
    TRADE_TP1_R: Number(process.env.TRADE_TP1_R) || 1.5,
    TRADE_TP2_R: Number(process.env.TRADE_TP2_R) || 2.5,
    TRADE_TP3_R: Number(process.env.TRADE_TP3_R) || 4,
    TRADE_MAX_LEVERAGE_CAP:
        Number(process.env.TRADE_MAX_LEVERAGE_CAP) || 5,
    TRADE_LEVERAGE_SAFETY_FACTOR:
        Number(process.env.TRADE_LEVERAGE_SAFETY_FACTOR) || 0.35,
    TRADE_ATR_STOP_BUFFER_MULT:
        Number(process.env.TRADE_ATR_STOP_BUFFER_MULT) || 0.1,
    /** Max share of account used as margin on one idea. */
    TRADE_MAX_MARGIN_FRACTION:
        Number(process.env.TRADE_MAX_MARGIN_FRACTION) || 0.40,
    /** Used when account currency is INR but pair is USDT-priced. */
    TRADE_USDT_INR_RATE:
        Number(process.env.TRADE_USDT_INR_RATE) || 90,

    /**
     * Auto trading (CoinDCX spot or futures).
     * Keep DRY_RUN=true until you verify payloads.
     * LIVE requires AUTO_TRADE_ENABLED=true AND AUTO_TRADE_DRY_RUN=false.
     * AUTO_TRADE_MARKET: futures | spot
     * AUTO_TRADE_SPOT_QUOTE: INR | USDT (spot market suffix, default INR)
     */
    AUTO_TRADE_ENABLED: process.env.AUTO_TRADE_ENABLED === 'true',
    AUTO_TRADE_DRY_RUN: process.env.AUTO_TRADE_DRY_RUN !== 'false',
    AUTO_TRADE_MARKET:
        (process.env.AUTO_TRADE_MARKET || 'futures').trim().toLowerCase() ===
            'spot'
            ? 'spot'
            : 'futures',
    AUTO_TRADE_SPOT_QUOTE:
        (process.env.AUTO_TRADE_SPOT_QUOTE || 'INR').trim().toUpperCase(),
    AUTO_TRADE_MIN_QUANTITY:
        Number(process.env.AUTO_TRADE_MIN_QUANTITY) || 0.0001,
    AUTO_TRADE_QUANTITY_DECIMALS:
        Number(process.env.AUTO_TRADE_QUANTITY_DECIMALS) || 4,

    CANDLE_ALERT_EMAIL_TO: process.env.CANDLE_ALERT_EMAIL_TO?.trim() || '',

    MAXIMUM_LIMIT_RATE: 5,
    CACHE_TTL: 1200, // 20 min

    /** express-rate-limit — per-IP HTTP flood protection (set RATE_LIMIT_ENABLED=false to disable). */
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED !== 'false',
    RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || (process.env.NODE_ENV === 'prod' ? 300 : 2000),
    RATE_LIMIT_AUTH_WINDOW_MS: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 15 * 60 * 1000,
    RATE_LIMIT_AUTH_MAX: Number(process.env.RATE_LIMIT_AUTH_MAX) || (process.env.NODE_ENV === 'prod' ? 60 : 500),
    RATE_LIMIT_PUBLIC_WINDOW_MS: Number(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS) || 15 * 60 * 1000,
    RATE_LIMIT_PUBLIC_MAX: Number(process.env.RATE_LIMIT_PUBLIC_MAX) || (process.env.NODE_ENV === 'prod' ? 120 : 1000),
};

// eslint-disable-next-line no-console
console.warn(config.NODE_ENV);

module.exports = config;
