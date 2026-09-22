/**
 * CoinDCX futures candlestick timeframe map.
 * Futures public API uses `resolution` (1 = 1m, 240 = 4h, 1D = daily).
 */
const TIMEFRAMES = {
    '1m': {
        label: '1m',
        resolution: '1',
        durationMs: 60 * 1000,
        // second 5 of every minute — after the prior 1m candle closes
        defaultCron: '5 * * * * *',
        pollLookbackCandles: 5,
    },
    '4h': {
        label: '4h',
        resolution: '240',
        durationMs: 4 * 60 * 60 * 1000,
        // minute 0 second 5 at UTC 4h boundaries
        defaultCron: '5 0 0,4,8,12,16,20 * * *',
        pollLookbackCandles: 4,
    },
    '1d': {
        label: '1d',
        resolution: '1D',
        durationMs: 24 * 60 * 60 * 1000,
        // 00:00:05 UTC — after the prior daily candle closes
        defaultCron: '5 0 0 * * *',
        pollLookbackCandles: 3,
    },
};

function resolveTimeframe(raw, resolutionOverride = '') {
    const key = String(raw || '1d').trim().toLowerCase();
    const base = TIMEFRAMES[key];
    if (!base) {
        throw new Error(
            `Unsupported COINDCX_SCANNER_TIMEFRAME "${raw}". Use 1m, 4h, or 1d.`,
        );
    }
    const override = String(resolutionOverride || '').trim();
    return {
        ...base,
        resolution: override || base.resolution,
    };
}

function closedBoundaryMs(nowMs, durationMs) {
    return Math.floor(nowMs / durationMs) * durationMs;
}

function historyFromSeconds(nowSeconds, candleCount, durationMs) {
    const secondsPerCandle = Math.max(1, Math.ceil(durationMs / 1000));
    return nowSeconds - candleCount * secondsPerCandle;
}

function pollLookbackSeconds(durationMs, lookbackCandles) {
    const secondsPerCandle = Math.max(1, Math.ceil(durationMs / 1000));
    return Math.max(3, lookbackCandles) * secondsPerCandle;
}

module.exports = {
    TIMEFRAMES,
    resolveTimeframe,
    closedBoundaryMs,
    historyFromSeconds,
    pollLookbackSeconds,
};
