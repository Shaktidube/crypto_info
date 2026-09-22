/** Rolling-window stats periods (not calendar months). */
const VALID_PERIODS = ['7d', '30d', '90d', '180d', 'all'];

/** @deprecated Legacy keys — mapped on read for stored stats and share URLs. */
const LEGACY_PERIOD_MAP = {
    '1w': '7d',
    '1m': '30d',
    '3m': '90d',
    '6m': '180d',
};

const ROLLING_PERIOD_DAYS = {
    '1d': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '180d': 180,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {string|undefined|null} period
 * @returns {string}
 */
function normalizePeriodKey(period) {
    if (!period || period === 'all') return 'all';
    const p = String(period).trim().toLowerCase();
    if (LEGACY_PERIOD_MAP[p]) return LEGACY_PERIOD_MAP[p];
    return p;
}

/**
 * Unix seconds at the start of a rolling window ending now.
 *
 * @param {string} period
 * @returns {number} 0 when period is `all` or unknown.
 */
function rollingPeriodStartUnix(period) {
    const key = normalizePeriodKey(period);
    if (!key || key === 'all') return 0;
    const days = ROLLING_PERIOD_DAYS[key];
    if (!days) return 0;
    return (Date.now() - days * MS_PER_DAY) / 1000;
}

/**
 * Renames legacy period keys on persisted MongoDB stats objects.
 *
 * @param {Object<string, *>|null|undefined} periods
 * @returns {Object<string, *>|null|undefined}
 */
function migrateLegacyPeriodKeys(periods) {
    if (!periods || typeof periods !== 'object') return periods;
    const out = { ...periods };
    for (const [legacy, modern] of Object.entries(LEGACY_PERIOD_MAP)) {
        if (out[legacy] != null && out[modern] == null) {
            out[modern] = out[legacy];
        }
        if (Object.prototype.hasOwnProperty.call(out, legacy)) {
            delete out[legacy];
        }
    }
    return out;
}

/**
 * @param {string|undefined|null} period
 * @returns {boolean}
 */
function isValidPeriod(period) {
    return VALID_PERIODS.includes(normalizePeriodKey(period));
}

module.exports = {
    VALID_PERIODS,
    LEGACY_PERIOD_MAP,
    ROLLING_PERIOD_DAYS,
    normalizePeriodKey,
    rollingPeriodStartUnix,
    migrateLegacyPeriodKeys,
    isValidPeriod,
};
