const axios = require('axios');
const crypto = require('crypto');
const ccxt = require('ccxt');
const config = require('../../../config/config');
const {
    rollingPeriodStartUnix,
} = require('./krakenPeriods');
const {
    calcROI,
    formatROI,
    groupByRefId,
    summarizeLedgerCoverage,
    createApplyLedgerAmountsForFifo,
    runFIFO,
    KRAKEN_LEDGER_FIFO_FIAT_ASSETS,
    isStablecoinFifoLeg,
    isFiatOnlyFifoLeg,
    isFifoBuyLeg,
    pruneFifoDustQueues,
    countOpenFifoLots,
    countFifoBuyLegs,
    summarizeQualifyingClosedLots,
    calcWinRatePct,
    getFirstTradingDayKey,
    filterFirstDayStableFundingSells,
    OPEN_POSITION_DUST_AUD,
    CLOSED_LOT_MIN_PROCEEDS_AUD,
} = require('./krakenStatsLedgerFifoHelpers');

// ═══════════════════════════════════════════════════════════════════════════════
// Kraken profile statistics for the app API.
//
// Flow: load balance + trades + ledgers → value portfolio and deposits → merge spot
// fills with fiat↔crypto ledger swaps → runFIFO on merged rows → headline ROI & best asset
// from realised FIFO (aligned with kraken-stats-debug); win rate, trading since, monthly.
// Optional console trace: set KRAKEN_STATS_CALC_LOG=1.
//
// Public exports at the bottom are stable for controllers and scripts.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Constants: which assets we treat as fiat for ledger and deposits ─────────

/**
 * After normalizing symbols, these count as “fiat side” when pairing ledger spend/receive
 * rows into synthetic buy/sell swaps.
 */
// const FIAT_ASSETS_FOR_LEDGER_SWAPS = [
//     'USD', 'USDT', 'USDC', 'USDS', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY',
//     'DAI', 'TUSD', 'PYUSD', 'USDE',
// ];

/**
 * USD-pegged stablecoins valued at exactly $1 per unit in deposit totals.
 * Non-USD fiat (EUR, GBP, CAD) must go through assetInfo to get the real FX rate.
 */
const USD_PEGGED_DEPOSIT_ASSETS = ['USD', 'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE'];

/**
 * Non-USD fiat currencies: valued using the assetInfo price from computePortfolioUsdMarks
 * (fetched via public Ticker ${ccy}USD). Falls back to 1.0 only if no price is available.
 */
const FIAT_DEPOSIT_ASSETS_NON_USD = ['EUR', 'GBP', 'CAD', 'AUD', 'JPY'];

// How to shape synthetic swap amounts from ledger pairs (see krakenStatsLedgerFifoHelpers).
// true = fees on buy + sell legs (cost basis ↑, proceeds ↓).
// 'buyOnly' = fees on purchase legs only (Kraken CSV FIFO reconciliation).
// false = gross amounts (ignore fees).
const applyLedgerPairAmountsForFifo = createApplyLedgerAmountsForFifo(true);
// const applyLedgerPairAmountsForFifo = createApplyLedgerAmountsForFifo('buyOnly');
// const applyLedgerPairAmountsForFifo = createApplyLedgerAmountsForFifo(false);

/**
 * @param {Error|unknown} err
 * @returns {boolean}
 */
function isKrakenRateLimitError(err) {
    const msg = String(err?.message || err || '');
    return (
        msg.includes('Rate limit') ||
        msg.includes('DDoSProtection') ||
        msg.includes('EAPI:Rate limit')
    );
}

/** Set KRAKEN_API_LOG=0 to silence Kraken HTTP call logs (default: on). */
function krakenApiLogEnabled() {
    const v = String(process.env.KRAKEN_API_LOG ?? '1').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Always-on Kraken HTTP trace (grep terminal for `[KrakenAPI]`).
 * @param {string} status - CALL | OK | FAIL | SYNC
 * @param {string} message
 * @param {Object} [meta]
 */
function logKrakenApi(status, message, meta) {
    if (!krakenApiLogEnabled()) return;
    const ts = new Date().toISOString();
    const suffix = meta && Object.keys(meta).length > 0
        ? ` ${JSON.stringify(meta)}`
        : '';
    // eslint-disable-next-line no-console
    console.log(`[KrakenAPI] ${status} ${message} @ ${ts}${suffix}`);
}

/**
 * Kraken returns ledgers as an id→row map; we sometimes only have an array. This builds
 * a fake map (index as key) so helper functions that expect the API shape still work.
 *
 * @param {Array<Object>} rows - Ledger rows from pagination.
 * @returns {Object<string, Object>}
 */
function ledgerRowsToKrakenMap(rows) {
    if (!rows?.length) return {};
    return Object.fromEntries(rows.map((entry, i) => [String(i), entry]));
}

// ─── OAuth: token endpoint URL ────────────────────────────────────────────────

/**
 * OAuth token URL from config, or Kraken’s default if unset.
 * @returns {string}
 */
function krakenOAuthTokenUrl() {
    const url = (config.KRAKEN_TOKEN_ENDPOINT || '').trim();
    if (url) return url;
    return 'https://api.kraken.com/oauth/token';
}

/**
 * Calls Kraken OAuth to swap a refresh token for new tokens (typically includes
 * access_token and a new refresh_token).
 *
 * @param {string} refreshToken - Kraken refresh token from the user record.
 * @returns {Promise<Object>} Parsed token payload from Kraken.
 * @throws {Error} Network/API errors; `isOAuthRefreshFailed` may be set on 401/400.
 */
async function refreshKrakenToken(refreshToken) {
    const rt = String(refreshToken || '').trim();
    if (!rt) {
        throw new Error('Kraken refresh: empty refresh_token');
    }

    const credentials = Buffer.from(
        `${config.KRAKEN_CLIENT_ID}:${config.KRAKEN_CLIENT_SECRET}`,
    ).toString('base64');

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
    });

    let response;
    try {
        response = await axios.post(
            krakenOAuthTokenUrl(),
            body.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'Authorization': `Basic ${credentials}`,
                },
            },
        );
    } catch (err) {
        const d = err.response?.data;
        const desc =
            d && typeof d === 'object'
                ? (d.error_description || d.error || d.message || '')
                : '';
        const msg = [
            `Kraken token refresh HTTP ${err.response?.status || 'n/a'}`,
            desc && String(desc),
            !desc && err.message,
        ]
            .filter(Boolean)
            .join(': ');
        const wrapped = new Error(msg);
        if (err.response?.status === 401 || err.response?.status === 400) {
            wrapped.isOAuthRefreshFailed = true;
        }
        throw wrapped;
    }

    const data = response.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Kraken token refresh: empty or non-JSON response');
    }
    if (data.error) {
        throw new Error(
            `Kraken token refresh: ${data.error}${data.error_description ? ` — ${data.error_description}` : ''}`,
        );
    }
    if (!data.access_token) {
        throw new Error(
            `Kraken token refresh: no access_token in response keys=${Object.keys(data).join(',')}`,
        );
    }

    return data;
}

// ─── OAuth: short-lived REST API key (Fast API Key) ─────────────────────────────

/**
 * Mints a Kraken “fast” API key+secret bound to the current access token, with read-only
 * style permissions used for balance, trades, and ledgers.
 *
 * @param {string} accessToken - Valid OAuth access token (Bearer).
 * @returns {Promise<{ apiKey: string, apiSecret: string }>}
 * @throws {Error} On HTTP error; `isTokenExpired` may be set on 401/403 or invalid session.
 */
async function getFastApiKey(accessToken) {
    const keyName = `tinka-${Date.now().toString(36)}`.slice(0, 32);
    const body = {
        api_key_name: keyName,
        permissions: {
            funds_query: true,
            trades_query_closed: true,
            ledger_query: true,
            export_data: true,
        },
    };

    let response;
    try {
        response = await axios.post(
            'https://api.kraken.com/oauth/fast-api-key',
            JSON.stringify(body),
            {
                maxBodyLength: Infinity,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
            },
        );
    } catch (axiosErr) {
        const status = axiosErr.response?.status;
        const msg = JSON.stringify(axiosErr.response?.data || axiosErr.message);
        const err = new Error(`Kraken fast-api-key HTTP ${status}: ${msg}`);
        if (status === 401 || status === 403) err.isTokenExpired = true;
        throw err;
    }

    const data = response.data;

    if (data.error && data.error.length > 0) {
        const msg = data.error.join(', ');
        const err = new Error(`Kraken fast-api-key: ${msg}`);
        if (msg.includes('EAPI:Invalid key') || msg.includes('ESession')) {
            err.isTokenExpired = true;
        }
        throw err;
    }

    const result = data.result || data;
    const apiKey = result.api_key || result.apiKey || result.key;
    const apiSecret = result.secret || result.api_secret || result.apiSecret;

    if (!apiKey || !apiSecret) {
        throw new Error('fast-api-key response missing api_key or secret fields');
    }

    return { apiKey, apiSecret };
}

/**
 * Deletes the Kraken fast API key associated with the given OAuth access token.
 * Endpoint: DELETE /oauth/fast-api-key.
 * @param {string} accessToken - Valid OAuth access token.
 * @param {string} [apiKeyName] - Optional name of the key to delete.
 * @returns {Promise<boolean>}
 */
async function deleteFastApiKey(accessToken, apiKeyName) {
    const data =
        apiKeyName ? JSON.stringify({ api_key_name: apiKeyName }) : undefined;

    const config = {
        method: 'delete',
        maxBodyLength: Infinity,
        url: 'https://api.kraken.com/oauth/fast-api-key',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
        },
        data,
    };

    try {
        await axios.request(config);
        return true;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            '[deleteFastApiKey] failed:',
            err.response?.data || err.message,
        );
        return false;
    }
}

/**
 * Lists the Kraken fast API keys associated with the given OAuth access token.
 * Endpoint: GET /oauth/fast-api-keys.
 * @param {string} accessToken - Valid OAuth access token.
 * @returns {Promise<Object|null>}
 */
async function listFastApiKeys(accessToken) {
    const config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: 'https://api.kraken.com/oauth/fast-api-keys',
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
        },
    };

    try {
        const response = await axios.request(config);
        return response.data;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            '[listFastApiKeys] failed:',
            err.response?.data || err.message,
        );
        return null;
    }
}

/**
 * Lists all fast API keys and deletes any whose name begins with "tinka-".
 * This helps avoid "EAccount:Too many API keys" by cleaning up stale session keys.
 *
 * @param {string} accessToken
 * @returns {Promise<void>}
 */
async function deleteAllTinkaFastApiKeys(accessToken) {
    const listRes = await listFastApiKeys(accessToken);
    const list = listRes?.result;
    if (!list || !Array.isArray(list)) return;

    for (const key of list) {
        const name = key.api_key_name || '';
        if (name.toLowerCase().startsWith('tinka-')) {
            await deleteFastApiKey(accessToken, name);
        }
    }
}

// ─── CCXT: private API function factory (replaces manual HMAC signing) ────────

/**
 * Creates a privateApiFn backed by CCXT's Kraken exchange instance.
 * CCXT handles nonce generation and HMAC-SHA512 signing automatically.
 *
 * @param {string} apiKey - Kraken API key.
 * @param {string} apiSecret - Kraken API secret (base64).
 * @returns {function(string, Object): Promise<Object>} Drop-in for krakenPrivateApiKey.
 */
function createCcxtApiFn(apiKey, apiSecret) {
    const exchange = new ccxt.kraken({
        apiKey,
        secret: apiSecret,
        enableRateLimit: false,
    });
    return async function ccxtPrivateFn(endpoint, params = {}) {
        const methodName = `privatePost${endpoint}`;
        if (typeof exchange[methodName] !== 'function') {
            throw new Error(`CCXT Kraken: no method for endpoint "${endpoint}"`);
        }
        const t0 = Date.now();
        try {
            const response = await exchange[methodName](params);
            logKrakenApi('OK', `CCXT private/${endpoint}`, {
                ms: Date.now() - t0,
            });
            if (response && Object.prototype.hasOwnProperty.call(response, 'result')) {
                return response.result;
            }
            return response;
        } catch (err) {
            logKrakenApi('FAIL', `CCXT private/${endpoint}`, {
                ms: Date.now() - t0,
                error: err.message,
            });
            throw err;
        }
    };
}

// ─── Spot REST: monotonic nonce (required on every private call) ──────────────

let _lastNonce = 0n;

/**
 * Returns a strictly increasing string nonce for this process (Kraken requirement).
 * @returns {string}
 */
function krakenNonce() {
    const now = BigInt(Date.now()) * 1000000n;
    const next = now > _lastNonce ? now : _lastNonce + 1n;
    _lastNonce = next;
    return next.toString();
}

// ─── Optional calculation trace (debugging formulas in production) ─────────────

/**
 * @returns {boolean} True when env KRAKEN_STATS_CALC_LOG is 1, true, or yes.
 */
function krakenStatsCalcLogEnabled() {
    const v = String(process.env.KRAKEN_STATS_CALC_LOG || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Prints a titled block of lines to the server console when tracing is enabled.
 * @param {string} section - Short title for the block (shown in the log header).
 * @param {string[]} lines - Human-readable lines to print under that title.
 */
function logKrakenStatsCalc(section, lines) {
    if (!krakenStatsCalcLogEnabled()) return;
}

// ─── Spot REST: signed private calls and public ticker ─────────────────────────

/**
 * Marks an error so callers can treat it as an expired or invalid Kraken session/key.
 * @param {Error} err - Error from Kraken or axios.
 * @returns {Error} Same reference, possibly with `isTokenExpired` set.
 */
function markTokenExpired(err) {
    const msg = err.message || '';
    if (
        msg.includes('EAPI:Invalid key') ||
        msg.includes('ESession:Invalid session')
    ) {
        err.isTokenExpired = true;
    }
    if (err.response?.status === 401 || err.response?.status === 403) {
        err.isTokenExpired = true;
    }
    return err;
}

/**
 * Private Spot REST POST using OAuth Bearer (nonce in body).
 *
 * @param {string} endpoint - e.g. 'Balance', 'Ledgers'.
 * @param {string} accessToken - OAuth access token.
 * @param {Object} [params] - Extra form fields (Kraken merges with nonce).
 * @returns {Promise<Object>} Kraken `result` object.
 */
async function krakenPrivateBearer(endpoint, accessToken, params = {}) {
    const nonce = krakenNonce();
    const bodyParams = new URLSearchParams();
    bodyParams.append('nonce', nonce);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        bodyParams.append(k, String(v));
    }
    const bodyStr = bodyParams.toString();

    const t0 = Date.now();
    logKrakenApi('CALL', `Bearer private/${endpoint}`, { params });
    try {
        const response = await axios.post(
            `https://api.kraken.com/0/private/${endpoint}`,
            bodyStr,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            },
        );
        if (response.data.error && response.data.error.length > 0) {
            const krakenErrMsg = response.data.error.join(', ');
            const krakenErr = new Error(`Kraken [${endpoint}]: ${krakenErrMsg}`);
            markTokenExpired(krakenErr);
            logKrakenApi('FAIL', `Bearer private/${endpoint}`, {
                ms: Date.now() - t0,
                error: krakenErrMsg,
            });
            throw krakenErr;
        }
        logKrakenApi('OK', `Bearer private/${endpoint}`, {
            ms: Date.now() - t0,
        });
        return response.data.result;
    } catch (err) {
        if (!err.message?.startsWith('Kraken [')) {
            logKrakenApi('FAIL', `Bearer private/${endpoint}`, {
                ms: Date.now() - t0,
                error: err.message,
            });
        }
        throw err;
    }
}

/**
 * Private Spot REST POST using API-Key + HMAC-SHA512 signature (nonce in body).
 *
 * @param {string} endpoint - e.g. 'TradesHistory'.
 * @param {string} apiKey - Public API key.
 * @param {string} apiSecret - Base64-encoded private key material.
 * @param {Object} [params] - Extra form fields.
 * @returns {Promise<Object>} Kraken `result` object.
 */
async function krakenPrivateApiKey(endpoint, apiKey, apiSecret, params = {}) {
    const nonce = krakenNonce();
    const bodyParams = new URLSearchParams();
    bodyParams.append('nonce', nonce);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        bodyParams.append(k, String(v));
    }
    const bodyStr = bodyParams.toString();
    const path = `/0/private/${endpoint}`;

    const sha256Hash = crypto
        .createHash('sha256')
        .update(nonce + bodyStr, 'utf8')
        .digest();
    const hmacData = Buffer.concat([Buffer.from(path, 'utf8'), sha256Hash]);
    const signature = crypto
        .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
        .update(hmacData)
        .digest('base64');

    const response = await axios.post(
        `https://api.kraken.com${path}`,
        bodyStr,
        {
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        },
    );
    if (response.data.error && response.data.error.length > 0) {
        throw new Error(`Kraken [${endpoint}]: ${response.data.error.join(', ')}`);
    }
    return response.data.result;
}

/**
 * Best-effort public Ticker for one pair (e.g. XXBTZUSD). Used to mark alt balances to USD.
 * @param {string} pair - Kraken pair code.
 * @returns {Promise<Object|null>} `result` map or null on failure.
 */
async function krakenPublicTicker(pair) {
    const t0 = Date.now();
    logKrakenApi('CALL', `public/Ticker pair=${pair}`);
    try {
        const r = await axios.get(
            'https://api.kraken.com/0/public/Ticker', { params: { pair } },
        );
        if (r.data.error?.length) throw new Error(r.data.error.join(', '));
        logKrakenApi('OK', `public/Ticker pair=${pair}`, {
            ms: Date.now() - t0,
        });
        return r.data.result;
    } catch (err) {
        logKrakenApi('FAIL', `public/Ticker pair=${pair}`, {
            ms: Date.now() - t0,
            error: err.message,
        });
        return null;
    }
}

// ─── Asset and pair string normalization ───────────────────────────────────────

/**
 * Maps Kraken internal codes (ZUSD, XXBT, …) to short display symbols (USD, BTC, …).
 * @param {string} raw - Asset code from API or ledger.
 * @returns {string}
 */
function normalizeAsset(raw) {
    if (!raw) return '';
    const map = {
        ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD',
        ZUSDT: 'USDT', ZUSDC: 'USDC', ZAUD: 'AUD',
        XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', XXRP: 'XRP', XLTC: 'LTC',
        XXLM: 'XLM', XZEC: 'ZEC', XMLN: 'MLN',
    };
    return map[raw] || raw.replace(/^[XZ]/, '').replace('XBT', 'BTC') || raw;
}

/**
 * Canonical FIFO leg code so ledger rows (USDT, ZUSDT) and TradesHistory quotes match one pool.
 * @param {string} raw - Kraken asset or quote code.
 * @returns {string}
 */
function normalizeKrakenFifoLegAsset(raw) {
    const c = String(raw || '');
    const stableMap = { ZUSDT: 'USDT', ZUSDC: 'USDC', ZAUD: 'AUD' };
    if (stableMap[c]) return stableMap[c];
    if (KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(c)) return c;
    return normalizeAsset(c) || c;
}

/**
 * Strips the quote side off a pair string and normalizes the base (e.g. XXBTZUSD → BTC).
 * @param {string} pair - Kraken pair identifier from TradesHistory.
 * @returns {string} Normalized base asset; defaults to BTC if parsing fails.
 */
function parsePairBase(pair) {
    const quotes = [
        'ZUSD', 'ZEUR', 'ZGBP', 'ZCAD',
        'USDT', 'USDC', 'DAI', 'TUSD', 'PYUSD', 'USDE', // stablecoins before USD to avoid partial match
        'USD', 'EUR', 'GBP', 'CAD',
        'XXBT', 'XBT', 'XETH', 'ETH',
    ];
    let base = pair || '';
    for (const q of quotes) {
        if (base.endsWith(q)) {
            base = base.slice(0, -q.length);
            break;
        }
    }
    return normalizeAsset(base) || 'BTC';
}

/**
 * Kraken quote leg for FIFO routing on TradesHistory spot pairs.
 * Stablecoin pairs must return USDT/USDC/etc. (not ZUSD) so they share FIFO pools with
 * ledger refid swaps that book the same stable verbatim.
 *
 * @param {string} pair - Kraken pair from TradesHistory.
 * @returns {string} e.g. ZAUD, USDT, ZUSD.
 */
function krakenQuoteAssetForFifo(pair) {
    const p = String(pair || '');
    if (/(ZAUD|AUD)$/i.test(p)) return 'ZAUD';
    if (/(ZJPY|JPY)$/i.test(p)) return 'ZJPY';
    if (/(ZGBP|GBP)$/i.test(p)) return 'ZGBP';
    if (/(ZCAD|CAD)$/i.test(p)) return 'ZCAD';
    if (/(ZEUR|EUR)$/i.test(p)) return 'ZEUR';
    if (/(ZUSDT|USDT)$/i.test(p)) return 'USDT';
    if (/(ZUSDC|USDC)$/i.test(p)) return 'USDC';
    if (/(DAI)$/i.test(p)) return 'DAI';
    if (/(TUSD)$/i.test(p)) return 'TUSD';
    if (/(PYUSD)$/i.test(p)) return 'PYUSD';
    if (/(USDE)$/i.test(p)) return 'USDE';
    if (/(ZUSD|USD)$/i.test(p)) return 'ZUSD';
    return 'ZUSD';
}

/**
 * Converts our internal merged trade list into the `{ sold*, bought*, date, refid }` shape
 * expected by runFIFO in krakenStatsLedgerFifoHelpers. Ledger-derived rows carry
 * `fifoSoldAsset` / `fifoBoughtAsset`; API fills are rebuilt from `pair`, price, qty, fees.
 *
 * @param {Array<Object>} trades - Time-sorted trades from buildChronologicalTradeList.
 * @returns {Array<Object>} Rows suitable for runFIFO (oldest first).
 */
function profileTradesToLedgerFifoRows(trades) {
    const rows = [];
    trades.forEach((t, i) => {
        const date = new Date(t.time * 1000).toISOString();
        const refid = `merged-${i}`;
        if (
            t.fifoSoldAsset != null &&
            t.fifoBoughtAsset != null
        ) {
            rows.push({
                refid,
                time: t.time,
                date,
                soldAsset: normalizeKrakenFifoLegAsset(t.fifoSoldAsset),
                soldAmount: t.fifoSoldAmount,
                boughtAsset: normalizeKrakenFifoLegAsset(t.fifoBoughtAsset),
                boughtAmount: t.fifoBoughtAmount,
            });
            return;
        }
        const quote = 
        normalizeKrakenFifoLegAsset(krakenQuoteAssetForFifo(t.pair));
        if (t.side === 'buy') {
            const boughtAmount = t.qty;
            const soldAmount = t.price * t.qty + (t.feeCost || 0);
            rows.push({
                refid,
                time: t.time,
                date,
                soldAsset: quote,
                soldAmount,
                boughtAsset: t.baseAsset,
                boughtAmount,
            });
            return;
        }
        if (t.side === 'sell') {
            const soldAmount = t.qty;
            // Mirror buy-side: deduct sell fee from proceeds so both sides are fee-adjusted.
            const boughtAmount = Math.max(0, t.price * t.qty - (t.feeCost || 0));
            rows.push({
                refid,
                time: t.time,
                date,
                soldAsset: t.baseAsset,
                soldAmount,
                boughtAsset: quote,
                boughtAmount,
            });
        }
    });
    return rows;
}

// ─── Data loading: TradesHistory, Balance, Ledgers ─────────────────────────────

/**
 * Normalizes Kraken TradesHistory responses whether `result` is `{ trades, count }` or a
 * flat map of trade ids (older clients).
 * @param {Object} result - Kraken `result` payload.
 * @returns {{ trades: Object, count: number }}
 */
function normalizeTradesHistoryResult(result) {
    if (!result || typeof result !== 'object') {
        return { trades: {}, count: 0 };
    }
    if (result.trades && typeof result.trades === 'object') {
        const trades = result.trades;
        const n = Object.keys(trades).length;
        return {
            trades,
            count:
                result.count != null && result.count !== ''
                    ? Number(result.count)
                    : n,
        };
    }
    const trades = {};
    let countFromResult = null;
    for (const [k, v] of Object.entries(result)) {
        if (k === 'count') {
            countFromResult =
                typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
            continue;
        }
        if (
            v &&
            typeof v === 'object' &&
            ('pair' in v || 'ordertxid' in v || 'time' in v || 'type' in v)
        ) {
            trades[k] = v;
        }
    }
    const n = Object.keys(trades).length;
    return {
        trades,
        count: countFromResult != null && !Number.isNaN(countFromResult)
            ? countFromResult
            : n,
    };
}

/**
 * Pulls every page of closed spot fills (50 per page) via TradesHistory.
 * @param {function(string, Object): Promise<Object>} privateApiFn - (endpoint, params) => result.
 * @param {number} [startUnix] - Optional unix timestamp (seconds). When set, only trades at or after this time are fetched.
 * @returns {Promise<{ trades: Object, count: number }>}
 */
async function fetchAllTradesHistory(privateApiFn, startUnix) {
    const merged = {};
    let ofs = 0;
    const pageSize = 50;
    let pageNum = 0;

    for (; ;) {
        pageNum += 1;
        const params = { ofs: String(ofs) };
        if (startUnix) params.start = String(Math.floor(startUnix));
        logKrakenApi('SYNC', `TradesHistory page=${pageNum} ofs=${ofs}`);
        const rawPage = await privateApiFn('TradesHistory', params);
        const page = normalizeTradesHistoryResult(rawPage);
        const batch = page.trades || {};
        const keys = Object.keys(batch);
        Object.assign(merged, batch);
        logKrakenApi('SYNC', `TradesHistory page=${pageNum} rows=${keys.length}`);
        if (keys.length < pageSize) break;
        ofs += pageSize;
    }

    const rawTrades = Object.values(merged);
    logKrakenApi('SYNC', `TradesHistory complete total=${rawTrades.length}`);
    return {
        trades: merged,
        count: rawTrades.length,
    };
}

/**
 * @param {function(string, Object): Promise<Object>} privateApiFn
 * @returns {Promise<Object>} Raw per-asset balance map (string amounts).
 */
async function fetchKrakenBalance(privateApiFn) {
    return privateApiFn('Balance', {});
}

/**
 * Loads TradesHistory with the user’s API key; if zero rows and a bearer token exists,
 * retries once with OAuth Bearer (some setups return fills only that way).
 *
 * @param {function(string, Object): Promise<Object>} privateApiFn - API-key private call.
 * @param {string} [bearerToken] - Optional OAuth access token.
 * @returns {Promise<{ tradesResult: Object, rawTrades: Array, usedBearerForTrades: boolean }>}
 */
async function 
loadTradesHistoryWithBearerFallback(privateApiFn, bearerToken, startUnix) {
    let tradesResult = await fetchAllTradesHistory(privateApiFn, startUnix);
    let usedBearerForTrades = false;
    if (
        tradesResult.count === 0 &&
        bearerToken &&
        typeof bearerToken === 'string' &&
        bearerToken.length > 0
    ) {
        try {
            const bearerFn = (ep, params) =>
                krakenPrivateBearer(ep, bearerToken, params);
            tradesResult = await fetchAllTradesHistory(bearerFn, startUnix);
            usedBearerForTrades = true;
        } catch {
            /* OAuth may not allow private REST the same way; keep API-key result */
        }
    }
    const rawTrades = Object.values(tradesResult.trades || {});
    return { tradesResult, rawTrades, usedBearerForTrades };
}

/**
 * Paginates Ledgers with type=all until Kraken returns no more rows (50 per request).
 * @param {function(string, Object): Promise<Object>} privateApiFn
 * @param {number} [startUnix] - Optional unix timestamp (seconds). When set, only ledger
 *   rows at or after this time are fetched (uses Kraken's native `start` param).
 * @returns {Promise<Array<Object>>} Flat list of ledger row objects.
 */
async function fetchAllLedgers(privateApiFn, startUnix) {
    const allLedgers = [];
    let ofs = 0;
    const pageSize = 50;
    let reportedTotal = null;
    let pageNum = 0;
    for (; ;) {
        pageNum += 1;
        const params = { type: 'all', ofs: String(ofs) };
        if (startUnix) params.start = String(Math.floor(startUnix));
        logKrakenApi('SYNC', `Ledgers page=${pageNum} ofs=${ofs}`);
        const ledgerRes = await privateApiFn('Ledgers', params);
        const ledgerObj = ledgerRes?.ledger || {};
        const pageLedgers = Object.values(ledgerObj);
        const batchLen = pageLedgers.length;

        if (reportedTotal === null && ledgerRes?.count != null && ledgerRes.count !== '') {
            reportedTotal = Number(ledgerRes.count);
        }

        if (batchLen === 0) break;
        allLedgers.push(...pageLedgers);
        logKrakenApi('SYNC', `Ledgers page=${pageNum} rows=${batchLen} total=${allLedgers.length}`);

        if (batchLen < pageSize) break;
        if (reportedTotal != null && allLedgers.length >= reportedTotal) break;

        ofs += batchLen;
    }
    logKrakenApi('SYNC', `Ledgers complete total=${allLedgers.length}`);
    return allLedgers;
}

/**
 * Keeps only rows with type `deposit` for funding / deposit-total logic.
 * @param {Array<Object>} allLedgers
 * @returns {Array<Object>}
 */
function filterDepositLedgerEntries(allLedgers) {
    return allLedgers.filter(l => l.type === 'deposit');
}

// ─── Portfolio value in USD (mark to market) ───────────────────────────────────

/**
 * Values each positive balance: USD/USDT/USDC at 1; other assets via public Ticker CCYUSD.
 *
 * @param {Object<string, string>} rawBalance - Kraken Balance map.
 * @returns {Promise<{ assetInfo: Object, portfolioUSD: number }>}
 *   assetInfo[ccy] = { balance, price, usdValue } for assets we could price.
 */
async function computePortfolioUsdMarks(rawBalance) {
    const assetInfo = {};
    let portfolioUSD = 0;
    for (const [rawCcy, rawAmt] of Object.entries(rawBalance)) {
        const amount = parseFloat(rawAmt);
        if (amount <= 0) continue;
        const ccy = normalizeAsset(rawCcy);
        if (['USD', 'USDT', 'USDC'].includes(ccy)) {
            portfolioUSD += amount;
            assetInfo[ccy] = { balance: amount, price: 1, usdValue: amount };
            continue;
        }
        const ticker = await krakenPublicTicker(`${ccy}USD`);
        if (ticker) {
            const price = parseFloat(Object.values(ticker)[0]?.c?.[0] || 0);
            const usdValue = amount * price;
            portfolioUSD += usdValue;
            assetInfo[ccy] = { balance: amount, price, usdValue };
        }
    }
    return { assetInfo, portfolioUSD };
}

/**
 * Ensures `assetInfo.AUD.price` (USD per 1 AUD) exists for dust valuation.
 * @param {Object} assetInfo
 */
async function ensureAudFxInAssetInfo(assetInfo) {
    if (assetInfo?.AUD?.price > 0) return;
    const ticker = await krakenPublicTicker('AUDUSD');
    if (!ticker) return;
    const price = parseFloat(Object.values(ticker)[0]?.c?.[0] || 0);
    if (price > 0) {
        assetInfo.AUD = { balance: 0, price, usdValue: 0 };
    }
}

// ─── Total deposits (USD) from deposit ledger lines ────────────────────────────

/**
 * Sums deposit rows into a single USD total for ROI denominator.
 * - USD-pegged stablecoins (USD, USDT, USDC, …) valued at exactly $1.
 * - Non-USD fiat (EUR, GBP, CAD, AUD, JPY) valued at assetInfo FX price (from public Ticker);
 *   falls back to 1.0 if no price available (e.g. user no longer holds that currency).
 * - Crypto deposits valued at assetInfo mark price; skipped if no price available.
 *
 * @param {Array<Object>} depositEntries - Ledger rows with type deposit.
 * @param {Object} assetInfo - From computePortfolioUsdMarks (prices per normalized asset).
 * @returns {{ totalDepositsUSD: number, depositBreakdown: Array }}
 */
function computeTotalDepositsUsd(depositEntries, assetInfo) {
    let totalDepositsUSD = 0;
    const depositBreakdown = [];
    for (const entry of depositEntries) {
        const ccy = normalizeAsset(entry.asset || '');
        const amount = Math.abs(parseFloat(entry.amount || 0));
        if (amount <= 0) continue;
        let addUsd;
        if (USD_PEGGED_DEPOSIT_ASSETS.includes(ccy)) {
            // True USD stablecoins: 1 unit = $1.00 exactly
            addUsd = amount;
            totalDepositsUSD += amount;
        } else if (FIAT_DEPOSIT_ASSETS_NON_USD.includes(ccy)) {
            // Non-USD fiat: use current FX rate from assetInfo, fall back to 1.0
            const fxRate = assetInfo[ccy]?.price ?? 1;
            addUsd = amount * fxRate;
            totalDepositsUSD += addUsd;
        } else {
            // Crypto deposits: use mark price; skip if no price available
            addUsd = amount * (assetInfo[ccy]?.price || 0);
            totalDepositsUSD += addUsd;
        }
        depositBreakdown.push({
            asset: ccy,
            amount,
            addUsd: Number(addUsd.toFixed(6)),
        });
    }
    return { totalDepositsUSD, depositBreakdown };
}

// ─── Pair ledger spend/receive rows by refid ───────────────────────────────────

/**
 * Groups ledger rows by refid, then keeps only refs that have both a spend and receive
 * (typical for a single booked swap).
 *
 * @param {Array<Object>} allLedgers
 * @returns {Object<string, { spend, receive, time }>}
 */
function groupLedgerSwapsByRefId(allLedgers) {
    const refGroups = groupByRefId(ledgerRowsToKrakenMap(allLedgers));
    const swapByRefid = {};
    for (const [ref, entries] of Object.entries(refGroups)) {
        if (ref === 'null' || ref === 'undefined' || ref === '') continue;
        const spend = entries.find(e => e.type === 'spend');
        const receive = entries.find(e => e.type === 'receive');
        if (!spend || !receive) continue;
        swapByRefid[ref] = {
            spend,
            receive,
            time: parseFloat(spend.time || receive.time || 0),
        };
    }
    return swapByRefid;
}

/**
 * True when a ledger leg is fiat or stablecoin (not a crypto base for pairing).
 * @param {string} asset
 * @returns {boolean}
 */
function isLedgerFiatOrStableLeg(asset) {
    const raw = String(asset || '');
    if (KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(raw)) return true;
    const norm = normalizeKrakenFifoLegAsset(raw);
    return KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(norm);
}

/**
 * Builds synthetic trades from ledger refid pairs:
 * - fiat/stable ↔ crypto → buy/sell (existing behaviour)
 * - fiat ↔ stablecoin (AUD↔USDT/USDC/USDS) → stable buy/sell round trips
 * - crypto ↔ crypto → swap rows (FIFO cost basis transfer)
 * - stable ↔ stable or fiat ↔ fiat → skipped
 *
 * @param {Object<string, { spend, receive, time }>} swapByRefid - From groupLedgerSwapsByRefId.
 * @returns {Array<Object>} Items with side, fifo* fields, time, etc.
 */
function parseLedgerSwapsFromLedgers(swapByRefid) {
    const parsedSwaps = [];
    for (const [refid, pair] of Object.entries(swapByRefid)) {
        if (!pair.spend || !pair.receive) continue;
        const shaped = applyLedgerPairAmountsForFifo({
            refid,
            soldAsset: pair.spend.asset,
            soldAmount: Math.abs(parseFloat(pair.spend.amount || 0)),
            soldFee: parseFloat(pair.spend.fee || 0),
            boughtAsset: pair.receive.asset,
            boughtAmount: parseFloat(pair.receive.amount || 0),
            boughtFee: parseFloat(pair.receive.fee || 0),
        });
        const spendFiat = isLedgerFiatOrStableLeg(shaped.soldAsset);
        const recvFiat = isLedgerFiatOrStableLeg(shaped.boughtAsset);

        const fifoFields = {
            time: pair.time,
            fifoSoldAsset: shaped.soldAsset,
            fifoBoughtAsset: shaped.boughtAsset,
            fifoSoldAmount: shaped.soldAmount,
            fifoBoughtAmount: shaped.boughtAmount,
        };

        if (recvFiat && !spendFiat) {
            const qty = shaped.soldAmount;
            const receiveProceeds = shaped.boughtAmount;
            parsedSwaps.push({
                side: 'sell',
                baseAsset: normalizeAsset(shaped.soldAsset),
                price: qty > 0 ? receiveProceeds / qty : 0,
                qty,
                feeCost: 0,
                ...fifoFields,
            });
        } else if (spendFiat && !recvFiat) {
            const qty = Math.abs(shaped.boughtAmount);
            const spendCost = Math.abs(shaped.soldAmount);
            parsedSwaps.push({
                side: 'buy',
                baseAsset: normalizeAsset(shaped.boughtAsset),
                price: qty > 0 ? spendCost / qty : 0,
                qty,
                feeCost: 0,
                ...fifoFields,
            });
        } else if (!spendFiat && !recvFiat) {
            parsedSwaps.push({
                side: 'swap',
                baseAsset: normalizeAsset(shaped.boughtAsset),
                price: 0,
                qty: shaped.boughtAmount,
                feeCost: 0,
                ...fifoFields,
            });
        } else if (
            isFiatOnlyFifoLeg(shaped.soldAsset) &&
            isStablecoinFifoLeg(shaped.boughtAsset)
        ) {
            const qty = Math.abs(shaped.boughtAmount);
            const spendCost = Math.abs(shaped.soldAmount);
            parsedSwaps.push({
                side: 'buy',
                baseAsset: normalizeAsset(shaped.boughtAsset),
                price: qty > 0 ? spendCost / qty : 0,
                qty,
                feeCost: 0,
                ...fifoFields,
            });
        } else if (
            isStablecoinFifoLeg(shaped.soldAsset) &&
            isFiatOnlyFifoLeg(shaped.boughtAsset)
        ) {
            const qty = shaped.soldAmount;
            const receiveProceeds = shaped.boughtAmount;
            parsedSwaps.push({
                side: 'sell',
                baseAsset: normalizeAsset(shaped.soldAsset),
                price: qty > 0 ? receiveProceeds / qty : 0,
                qty,
                feeCost: 0,
                ...fifoFields,
            });
        }
    }
    return parsedSwaps;
}

/** @deprecated Use parseLedgerSwapsFromLedgers — kept as alias for clarity in older comments. */
// function parseFiatCryptoSwapsFromLedgers(swapByRefid) {
//     return parseLedgerSwapsFromLedgers(swapByRefid);
// }

// ─── One timeline: API fills + synthetic ledger swaps ─────────────────────────

/**
 * Merges TradesHistory fills and ledger-derived swaps, sorted by unix time ascending.
 *
 * @param {Array<Object>} rawTrades - Kraken trade rows (pair, type, price, vol, fee, time).
 * @param {Array<Object>} parsedSwaps - From parseLedgerSwapsFromLedgers.
 * @returns {{ trades: Array<Object>, totalTrades: number }}
 */
function buildChronologicalTradeList(rawTrades, parsedSwaps) {
    const trades = [
        ...rawTrades.map(t => ({
            side: t.type,
            baseAsset: parsePairBase(t.pair),
            pair: t.pair || '',
            price: parseFloat(t.price || 0),
            qty: parseFloat(t.vol || 0),
            feeCost: parseFloat(t.fee || 0),
            time: parseFloat(t.time || 0),
        })),
        ...parsedSwaps,
    ].sort((a, b) => a.time - b.time);
    return { trades, totalTrades: trades.length };
}

// ─── ROI string for the profile card ───────────────────────────────────────────

/**
 * If deposits > 0: percentage gain vs deposits. If not: show 0%.
 *
 * @param {number} portfolioUSD - Current marked portfolio value.
 * @param {number} totalDepositsUSD - Sum of deposits used as cost basis.
 * @returns {{ roi: string, roiTrend: string, roiPct: number|null }}
 */
// function formatRoiForDisplay(portfolioUSD, totalDepositsUSD) {
//     let roi;
//     let roiTrend;
//     let roiPct = null;
//     if (totalDepositsUSD > 0) {
//         roiPct = calcROI(
//             portfolioUSD - totalDepositsUSD,
//             totalDepositsUSD,
//         );
//         const sign = (roiPct ?? 0) >= 0 ? '+' : '';
//         roi = `${sign}${(roiPct ?? 0).toFixed(1)}%`;
//         roiTrend = (roiPct ?? 0) >= 0 ? 'positive' : 'negative';
//     } else {
//         roi = '0%';
//         roiTrend = 'neutral';
//     }
//     return { roi, roiTrend, roiPct };
// }

// ─── FIFO realised rollups (same idea as kraken-stats-debug buildAssetSummary) ───

/**
 * Picks the asset with highest realised FIFO ROI (same rule as debug “Best by ROI”).
 *
 * @param {Object<string, Object>} summary - From summarizeQualifyingClosedLots().byAsset.
 * @returns {{ bestAsset: string|null, bestAssetRoi: string|null, bestAssetCalcLog: Array }}
 */
function selectBestAssetFromFifoSummary(summary) {
    const bestAssetCalcLog = [];
    for (const s of Object.values(summary)) {
        const pct = s.roi;
        const inv = s.totalCostBasis;
        const pl = s.totalProfitLoss;
        const proc = s.totalProceeds;
        const expanded =
            pct != null
                ? `roi = calcROI(${pl.toFixed(8)}, ${inv.toFixed(8)}) × 100 = ${pct.toFixed(4)}%`
                : `roi = n/a (zero cost basis); ΣP&L = ${pl.toFixed(8)}`;
        bestAssetCalcLog.push({
            asset: s.asset,
            formula: 'roi = calcROI(Σ profitLoss, Σ costBasis) on FIFO sell legs',
            totalProceeds: Number(proc.toFixed(8)),
            totalCostBasis: Number(inv.toFixed(8)),
            totalProfitLoss: Number(pl.toFixed(8)),
            expanded,
            pct: pct != null ? Number(pct.toFixed(4)) : null,
        });
    }
    bestAssetCalcLog.sort(
        (a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity),
    );

    const EXCLUDE_FROM_BEST_ASSET = new Set([
        'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY',
        'ZAUD', 'ZUSD', 'ZEUR', 'ZGBP', 'ZCAD', 'ZJPY',
    ]);
    const withRoi = Object.values(summary).filter(
        a => a.roi != null && a.totalCostBasis > 0 && 
        !EXCLUDE_FROM_BEST_ASSET.has(a.asset),
    );
    if (!withRoi.length) {
        return { bestAsset: null, bestAssetRoi: null, bestAssetCalcLog };
    }
    const best = withRoi.reduce((x, y) => (y.roi > x.roi ? y : x));
    return {
        bestAsset: best.asset,
        bestAssetRoi: `${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}%`,
        bestAssetCalcLog,
    };
}

// ─── “Trading since” labels and monthly activity counts ─────────────────────────

/**
 * Formats the earliest activity timestamp into a month/year label and a duration subtitle.
 * @param {number} earliestUnixSec - Unix seconds.
 * @returns {{ tradingSince: string|null, tradingSinceSub: string|null, startAtUnix: number|null }}
 */
function tradingSinceFromUnixTime(earliestUnixSec) {
    const t = Number(earliestUnixSec);
    if (!Number.isFinite(t) || t <= 0) {
        return {
            tradingSince: null,
            tradingSinceSub: null,
            startAtUnix: null,
        };
    }
    const floored = Math.floor(t);
    const earliest = new Date(floored * 1000);
    const tradingSince = earliest.toLocaleDateString(
        'en-US', { month: 'long', year: 'numeric' },
    );
    const now = new Date();
    const diffMs = now - earliest;
    const years = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365));
    const months = Math.floor(
        (diffMs % (1000 * 60 * 60 * 24 * 365)) / (1000 * 60 * 60 * 24 * 30),
    );
    const tradingSinceSub = [
        years > 0 ? `${years} year${years > 1 ? 's' : ''}` : '',
        months > 0 ? `${months} month${months > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' ');
    return { tradingSince, tradingSinceSub, startAtUnix: floored };
}

/**
 * Uses the first merged trade’s time (after chronological sort) as “trading since”.
 * @param {Array<Object>} trades - Non-empty chronological list.
 */
function deriveTradingSinceLabels(trades) {
    if (!trades.length) {
        return {
            tradingSince: null,
            tradingSinceSub: null,
            startAtUnix: null,
        };
    }
    return tradingSinceFromUnixTime(trades[0].time);
}

/**
 * Fallback when there are no merged trades: oldest ledger row time (any type).
 * @param {Array<Object>} allLedgers
 */
function deriveTradingSinceFromLedgerRows(allLedgers) {
    if (!allLedgers?.length) {
        return {
            tradingSince: null,
            tradingSinceSub: null,
            startAtUnix: null,
        };
    }
    let minT = Infinity;
    for (const l of allLedgers) {
        const t = parseFloat(l.time || 0);
        if (t > 0 && t < minT) minT = t;
    }
    if (!Number.isFinite(minT) || minT <= 0) {
        return {
            tradingSince: null,
            tradingSinceSub: null,
            startAtUnix: null,
        };
    }
    return tradingSinceFromUnixTime(minT);
}

/**
 * UI payload for the passport “Trading since” block (title, labels, ISO start).
 * @param {{ tradingSince: string|null, tradingSinceSub: string|null, startAtUnix: number|null }} bundle
 * @returns {Object|null}
 */
function buildTradingSinceCard(bundle) {
    const { tradingSince, tradingSinceSub, startAtUnix } = bundle;
    if (!tradingSince && !tradingSinceSub) return null;
    return {
        title: 'Trading since',
        durationLabel: tradingSinceSub || '',
        monthYearLabel: tradingSince || '',
        startAtUnix,
        startAtIso:
            startAtUnix != null
                ? new Date(startAtUnix * 1000).toISOString()
                : null,
    };
}

/**
 * Buckets FIFO buy legs into the last six calendar months (server local timezone).
 * Bar chart values = monthly buy counts (matches Kraken CSV reconciliation).
 *
 * @param {Array<Object>} fifoInputRows - Full runFIFO input (all-time, with `time`).
 * @returns {{
 *   monthlyTrades: Array<{ month: string, value: number, pairs: number }>,
 *   last6MonthsTrades: number,
 *   last6MonthsPairs: number
 * }}
 */
function computeMonthlyTradesLastSixMonths(fifoInputRows) {
    const buyRows = (fifoInputRows || []).filter(r => isFifoBuyLeg(r));
    const now = new Date();
    const monthlyTrades = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = d.toLocaleDateString('en-US', { month: 'short' });
        const start = d.getTime() / 1000;
        const end = new Date(
            d.getFullYear(),
            d.getMonth() + 1,
            1,
        ).getTime() / 1000;

        const buys = buyRows.filter(
            r => r.time >= start && r.time < end,
        ).length;

        monthlyTrades.push({ month: label, value: buys, pairs: buys });
    }
    const last6MonthsPairs = monthlyTrades.reduce((sum, m) => sum + m.pairs, 0);
    return {
        monthlyTrades,
        last6MonthsTrades: last6MonthsPairs,
        last6MonthsPairs,
    };
}

// ─── Main entry: build the profile stats object for the API ────────────────────

/**
 * Fetches balance, trades, ledgers, and portfolio marks from Kraken (expensive I/O).
 * Cached per-user by controllers; period filtering happens in computeKrakenStatsFromRaw.
 *
 * @param {function(string, Object): Promise<Object>} privateApiFn
 * @param {string} [bearerToken]
 * @returns {Promise<Object>}
 */
async function fetchKrakenStatsRawData(privateApiFn, bearerToken, userId) {
    const uid = userId ? String(userId) : 'unknown';
    const syncT0 = Date.now();
    logKrakenApi('SYNC', `user=${uid} fetch START`);

    logKrakenApi('SYNC', `user=${uid} step=Balance`);
    const rawBalance = await fetchKrakenBalance(privateApiFn);

    logKrakenApi('SYNC', `user=${uid} step=TradesHistory`);
    const { tradesResult, rawTrades, usedBearerForTrades } =
        await loadTradesHistoryWithBearerFallback(privateApiFn, bearerToken);

    logKrakenStatsCalc('1–2 · Balance & TradesHistory', [
        'Balance: non-zero entries from private Balance (per-asset string amounts).',
        `TradesHistory (Spot): count=${tradesResult.count ?? rawTrades.length} fills (API pagination merged).`,
        'Ledgers: no period filter — full history required for FIFO buy-side matching.',
        usedBearerForTrades
            ? 'Note: Retried TradesHistory with OAuth bearer after API-key returned 0.'
            : 'Note: TradesHistory via API key only (no bearer retry or bearer unused).',
    ]);

    let allLedgers = [];
    try {
        logKrakenApi('SYNC', `user=${uid} step=Ledgers`);
        allLedgers = await fetchAllLedgers(privateApiFn);
    } catch (ledgerErr) {
        if (ledgerErr.isTokenExpired) throw ledgerErr;
        logKrakenApi('FAIL', `user=${uid} Ledgers`, { error: ledgerErr.message });
    }

    const depositEntries = filterDepositLedgerEntries(allLedgers);

    const ledgerLogLines = [
        `Ledger rows fetched (paginated): ${allLedgers.length}`,
        `Deposit-type rows: ${depositEntries.length}  → used for totalDepositsUSD`,
        'Spend+receive rows with same refid → paired for synthetic spot-like trades (crypto, stablecoin AUD round trips, crypto swaps).',
        'Refid grouping uses groupByRefId (krakenStatsLedgerFifoHelpers) on merged rows.',
    ];
    if (krakenStatsCalcLogEnabled()) {
        const cov = summarizeLedgerCoverage(ledgerRowsToKrakenMap(allLedgers));
        ledgerLogLines.push(
            `summarizeLedgerCoverage: totalRows=${cov.totalRows} ` +
            `rowsWithMissingRefid=${cov.rowsWithMissingRefid}`,
            `  byType: ${JSON.stringify(cov.byType)}`,
        );
    }
    logKrakenStatsCalc('3 · Ledgers', ledgerLogLines);

    logKrakenApi('SYNC', `user=${uid} step=PortfolioMarks`);
    const { assetInfo, portfolioUSD } =
        await computePortfolioUsdMarks(rawBalance);
    await ensureAudFxInAssetInfo(assetInfo);

    logKrakenApi('SYNC', `user=${uid} fetch DONE`, {
        ms: Date.now() - syncT0,
        trades: rawTrades.length,
        ledgers: allLedgers.length,
        portfolioUSD: Number(portfolioUSD.toFixed(2)),
        usedBearerForTrades,
    });

    return {
        rawBalance,
        tradesResult,
        rawTrades,
        usedBearerForTrades,
        allLedgers,
        depositEntries,
        assetInfo,
        portfolioUSD,
    };
}

/**
 * Derives period-filtered stats from prefetched Kraken data (no network I/O).
 *
 * @param {Object} rawData - Output of fetchKrakenStatsRawData.
 * @param {string} [period='all']
 * @returns {Object}
 */
function computeKrakenStatsFromRaw(rawData, period = 'all') {
    const {
        rawTrades,
        allLedgers,
        depositEntries,
        assetInfo,
    } = rawData;

    const periodStartUnix = rollingPeriodStartUnix(period);

    const { totalDepositsUSD, depositBreakdown } = computeTotalDepositsUsd(
        depositEntries,
        assetInfo
    );

    logKrakenStatsCalc('5 · Total deposits (USD)', [
        'Formula: totalDepositsUSD = Σ deposit ledger amounts; fiat-ish assets count face value; crypto deposits use assetInfo[asset].price.',
        `totalDepositsUSD = ${totalDepositsUSD.toFixed(4)}`,
        `Deposit line contributions: ${JSON.stringify(depositBreakdown, null, 2)}`,
    ]);

    const swapByRefid = groupLedgerSwapsByRefId(allLedgers);
    const parsedSwaps = parseLedgerSwapsFromLedgers(swapByRefid);
    const ledgerFiatCryptoCount = parsedSwaps.filter(t => t.side === 'buy' || t.side === 'sell').length;
    const ledgerCryptoSwapCount = parsedSwaps.filter(t => t.side === 'swap').length;
    const ledgerStableFiatCount = parsedSwaps.filter(
        t => (t.side === 'buy' || t.side === 'sell') &&
            ['USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE'].includes(t.baseAsset),
    ).length;
    const {
        trades: mergedTrades,
        totalTrades: mergedFillCount,
    } = buildChronologicalTradeList(rawTrades, parsedSwaps);

    // Client reconciliation is ledger-first FIFO: use ledger-derived swaps as the
    // canonical FIFO input when available; fall back to merged feeds if ledger swaps
    // are unavailable for the account/session.
    const {
        trades,
        totalTrades: fifoSourceFillCount,
    } = parsedSwaps.length > 0
        ? buildChronologicalTradeList([], parsedSwaps)
        : { trades: mergedTrades, totalTrades: mergedFillCount };

    logKrakenStatsCalc('6 · Merged trades (chronological)', [
        `From TradesHistory: ${rawTrades.length} rows → mapped to { side, baseAsset, price, qty, feeCost, time }.`,
        `From ledgers: ${parsedSwaps.length} synthetic rows ` +
        `(${ledgerFiatCryptoCount - ledgerStableFiatCount} fiat/stable↔crypto, ` +
        `${ledgerStableFiatCount} fiat↔stablecoin, ${ledgerCryptoSwapCount} crypto↔crypto).`,
        `Synthetic swap amounts: ${applyLedgerPairAmountsForFifo.mode} ` +
        '(toggle createApplyLedgerAmountsForFifo lines near top of file).',
        `mergedFillCount (spot buys + sells + swaps, not round trips) = ${mergedFillCount}`,
        `fifoSourceFillCount (rows actually sent to FIFO) = ${fifoSourceFillCount}`,
        parsedSwaps.length > 0
            ? 'FIFO source: ledger-derived swaps only (client reconciliation mode).'
            : 'FIFO source: merged TradesHistory + ledger swaps (ledger swaps unavailable).',
    ]);

    const ledgerFifoInput = profileTradesToLedgerFifoRows(trades);
    const ledgerFifoInputForPeriod = periodStartUnix > 0
        ? ledgerFifoInput.filter(r => r.time >= periodStartUnix)
        : ledgerFifoInput;
    const { realisedPnL: ledgerFifoRealisedAll, fifoQueues: ledgerFifoQueues } =
        runFIFO(ledgerFifoInput);

    const ledgerFifoRealised = periodStartUnix > 0
        ? ledgerFifoRealisedAll.filter(r => (new Date(r.date).getTime() / 1000)
        >= periodStartUnix)
        : ledgerFifoRealisedAll;

    const firstTradingDayKey = getFirstTradingDayKey(ledgerFifoInput);
    const headlineRealised = filterFirstDayStableFundingSells(
        ledgerFifoRealised,
        { firstTradingDayKey },
    );

    const lotMetricOpts = {
        assetInfo,
        minProceedsAud: CLOSED_LOT_MIN_PROCEEDS_AUD,
    };
    // ROI / best asset: first-day stable funding hops removed, then leftovers +
    // sub-AUD-floor lots ignored.
    const headlineLotSummary = summarizeQualifyingClosedLots(
        headlineRealised,
        lotMetricOpts,
    );
    // Win rate / closed count: same lot filters on period sells (no dust extras).
    const periodLotSummary = summarizeQualifyingClosedLots(
        ledgerFifoRealised,
        lotMetricOpts,
    );

    const sumLedgerFifoPnl = headlineLotSummary.totalProfitLoss;
    const totalFifoCostBasis = headlineLotSummary.totalCostBasis;
    const fifoSummaryByAsset = headlineLotSummary.byAsset;
    const dustQueuesRemoved = pruneFifoDustQueues(ledgerFifoQueues, assetInfo, {
        normalizeAsset,
    });
    const openFifoKeys = Object.keys(ledgerFifoQueues).filter(
        k => (ledgerFifoQueues[k] || []).some(lot => lot.amount > 1e-12),
    );
    const STABLE_FIFO_CODES = new Set([
        'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE', 'ZUSDT', 'ZUSDC',
    ]);
    const stableFifoInputRows = ledgerFifoInput.filter(
        (r) =>
            STABLE_FIFO_CODES.has(r.soldAsset) ||
            STABLE_FIFO_CODES.has(r.boughtAsset),
    );
    const stableFifoSells = ledgerFifoRealised.filter((r) =>
        STABLE_FIFO_CODES.has(r.fiatCurrency),
    );
    const stableFifoPnl = stableFifoSells.reduce((s, r) => s + r.profitLoss, 0);
    const stableFifoCost = stableFifoSells.reduce((s, r) => s + r.costBasis, 0);

    logKrakenStatsCalc('6b · Ledger FIFO (processBuy / Sell / Swap)', [
        `runFIFO input rows: ${ledgerFifoInput.length}; realised sell legs: ${ledgerFifoRealised.length}`,
        `Σ profitLoss (qualifying lots, ≥ AUD ${CLOSED_LOT_MIN_PROCEEDS_AUD}): ${sumLedgerFifoPnl.toFixed(6)}`,
        `Σ costBasis (qualifying lots): ${totalFifoCostBasis.toFixed(6)}`,
        `Open FIFO queues (non-empty, after dust prune): ${openFifoKeys.length ? openFifoKeys.join(', ') : '(none)'}`,
        `Dust prune: removed ${dustQueuesRemoved} queue(s) valued below AUD ${OPEN_POSITION_DUST_AUD}`,
        `Stablecoin legs in FIFO input: ${stableFifoInputRows.length} row(s); ` +
        `sells settled in stable: ${stableFifoSells.length} ` +
        `(Σ P&L ${stableFifoPnl.toFixed(6)}, Σ cost ${stableFifoCost.toFixed(6)})`,
    ]);

    let roi;
    let roiTrend;
    let roiPct;
    if (totalFifoCostBasis > 0) {
        roiPct = calcROI(sumLedgerFifoPnl, totalFifoCostBasis);
        const sign = (roiPct ?? 0) >= 0 ? '+' : '';
        roi = `${sign}${(roiPct ?? 0).toFixed(2)}%`;
        roiTrend = (roiPct ?? 0) >= 0 ? 'positive' : 'negative';
    } else {
        roi = '0%';
        roiTrend = 'neutral';
        roiPct = 0;
    }

    logKrakenStatsCalc('7 · ROI', totalFifoCostBasis > 0
        ? [
            'Headline ROI: realised P&L vs FIFO cost on qualifying closed lots only.',
            `Unmatched leftovers ignored; lots with proceeds < AUD ${CLOSED_LOT_MIN_PROCEEDS_AUD} ignored.`,
            'Formula: roiPct = calcROI(Σ lot P&L, Σ lot cost).',
            `  Σ profitLoss = ${sumLedgerFifoPnl.toFixed(6)}, Σ costBasis = ${totalFifoCostBasis.toFixed(6)}`,
            `  = ${roiPct != null ? roiPct.toFixed(4) : 'n/a'}%`,
            `  formatROI (debug helper, 2dp): ${formatROI(roiPct)}`,
            `Display: roi = “${roi}”, roiTrend = “${roiTrend}”`,
        ]
        : [
            'No qualifying FIFO closed lots with cost basis → ROI shown as 0%.',
            `Display: roi = “${roi}”, roiTrend = “${roiTrend}”`,
        ]);

    const totalPairs = periodLotSummary.closedLots;
    const openPositions = countOpenFifoLots(ledgerFifoQueues);
    const totalTrades = countFifoBuyLegs(ledgerFifoInputForPeriod);
    const wins = periodLotSummary.wins;
    const winRate = calcWinRatePct(wins, totalPairs);

    logKrakenStatsCalc('8 · Win rate (FIFO lot records)', [
        'Source: qualifying matched FIFO lot slices only (no unmatched leftovers / dust extras).',
        `Min lot proceeds: AUD ${CLOSED_LOT_MIN_PROCEEDS_AUD}.`,
        'totalTrades = FIFO buy legs in period (ledger + spot buys).',
        'Win-rate denominator = closed FIFO lot records (totalPairs).',
        `totalTrades (buy legs) = ${totalTrades}`,
        `totalPairs (closed lot records) = ${totalPairs}`,
        `openPositions = ${openPositions} (FIFO lots after dust prune < AUD ${OPEN_POSITION_DUST_AUD})`,
        `profitable closed lots = ${wins}`,
        `winRate = round((${wins} / ${totalPairs}) × 100, 1dp) = ${winRate}%`,
        `sell legs in period: ${ledgerFifoRealised.length}`,
        `realisedPnL detail: ${JSON.stringify(ledgerFifoRealised, null, 2)}`,
    ]);

    const { bestAsset, bestAssetRoi, bestAssetCalcLog } =
        selectBestAssetFromFifoSummary(fifoSummaryByAsset);

    const bestAssetLogLines = [
        'Best asset = max realised FIFO ROI by asset (same roll-up as kraken-stats-debug buildAssetSummary).',
        'Per asset: Σ profitLoss and Σ costBasis over runFIFO sell legs → roi = calcROI(ΣP&L, Σcost).',
        'Per asset (values substituted):',
    ];
    for (const row of bestAssetCalcLog) {
        bestAssetLogLines.push(`  [${row.asset}] ${row.expanded}`);
    }
    bestAssetLogLines.push(
        `Full JSON: ${JSON.stringify(bestAssetCalcLog, null, 2)}`,
        `Chosen (max pct): bestAsset="${bestAsset}", bestAssetRoi="${bestAssetRoi}"`
    );
    logKrakenStatsCalc('9 · Best asset (by % return vs invested)', bestAssetLogLines);

    let tradingSinceBundle = deriveTradingSinceLabels(trades);
    if (!tradingSinceBundle.tradingSince && allLedgers.length > 0) {
        tradingSinceBundle = deriveTradingSinceFromLedgerRows(allLedgers);
    }
    const { tradingSince, tradingSinceSub } = tradingSinceBundle;
    const tradingSinceCard = buildTradingSinceCard(tradingSinceBundle);

    const { monthlyTrades, last6MonthsTrades, last6MonthsPairs } =
        computeMonthlyTradesLastSixMonths(ledgerFifoInput);

    logKrakenStatsCalc('10–11 · Trading since & monthly counts', [
        trades.length > 0
            ? `Earliest trade time (unix s): ${trades[0].time} → tradingSince / tradingSinceSub from that instant.`
            : tradingSinceBundle.tradingSince
                ? 'No merged trades; tradingSince from oldest ledger row (proxy).'
                : 'No trades and no ledger rows → tradingSince empty.',
        'Monthly: FIFO buy legs per calendar month (bar chart).',
        `monthlyTrades = ${JSON.stringify(monthlyTrades, null, 2)}`,
        'Formula: last6MonthsTrades = Σ month buys',
        `last6MonthsTrades = ${last6MonthsTrades}`,
        `Cross-check: totalTrades (period) = buy legs = ${totalTrades}; closed lot records = ${totalPairs}; open = ${openPositions}.`,
    ]);

    return {
        roi,
        roiTrend,
        winRate,
        profitableTrades: wins,
        totalPairs,
        openPositions,
        bestAsset,
        bestAssetRoi,
        tradingSince,
        tradingSinceSub,
        tradingSinceCard,
        totalTrades,
        last6MonthsTrades,
        last6MonthsPairs,
        monthlyTrades,
    };
}

/**
 * Orchestrates all steps above and returns the object consumed by the user profile API.
 * Does not change response shape when internals change—only documented fields are stable.
 *
 * @param {function(string, Object): Promise<Object>} privateApiFn - Kraken private caller
 *   bound to the user’s key or session (endpoint name + POST body params).
 * @param {{ bearerToken?: string, period?: string, prefetched?: Object }} [options]
 * @returns {Promise<Object>} roi (realised FIFO vs cost when sells exist; else MTM vs deposits),
 *   roiTrend, winRate, profitableTrades, totalPairs, openPositions, bestAsset / bestAssetRoi (FIFO realised
 *   per asset, same rule as kraken-stats-debug), tradingSince*, totalTrades (= FIFO buy legs in period),
 *   monthlyTrades.
 */
async function computeKrakenStats(privateApiFn, options = {}) {
    const { bearerToken, period, prefetched } = options;
    const rawData = prefetched
        || await 
        fetchKrakenStatsRawData(privateApiFn, bearerToken, options.userId);
    return computeKrakenStatsFromRaw(rawData, period);
}

/**
 * Stable public API for this module. Everything else is internal to profile stats.
 */
module.exports = {
    computeKrakenStats,
    computeKrakenStatsFromRaw,
    fetchKrakenStatsRawData,
    isKrakenRateLimitError,
    logKrakenApi,
    refreshKrakenToken,
    getFastApiKey,
    deleteFastApiKey,
    listFastApiKeys,
    deleteAllTinkaFastApiKeys,
    krakenPrivateBearer,
    krakenPrivateApiKey,
    createCcxtApiFn,
};
