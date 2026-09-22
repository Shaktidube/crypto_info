const { simpleMovingAverage } = require('../../../utils/lib/candleIndicators');
const { candleMetrics } = require('../metrics');

/**
 * Market context is separate from raw pattern geometry.
 * Trend uses SMA of closes ending at the candle before the pattern window
 * so pattern bars themselves do not redefine the prior trend (reduces look-ahead
 * into the pattern's own move).
 */
function detectTrend(candlesBeforePattern, thresholds) {
    const period = thresholds.trendSmaPeriod;
    // Need period+1 closes so current SMA and prior SMA are both defined.
    if (!Array.isArray(candlesBeforePattern) ||
        candlesBeforePattern.length < period + 1) {
        return {
            trend: 'unknown',
            strength: 0,
            sma: null,
            slope: null,
            explanation: 'Insufficient history for trend SMA.',
        };
    }

    const closes = candlesBeforePattern.map((c) => c.close);
    const sma = simpleMovingAverage(closes, period);
    const priorSma = simpleMovingAverage(closes.slice(0, -1), period);
    const lastClose = closes.at(-1);
    if (sma == null || priorSma == null || !Number.isFinite(lastClose)) {
        return {
            trend: 'unknown',
            strength: 0,
            sma,
            slope: null,
            explanation: 'Trend SMA unavailable.',
        };
    }

    const slope = (sma - priorSma) / priorSma;
    const minSlope = thresholds.trendMinSlopePercent;
    let trend = 'sideways';
    if (lastClose > sma && slope >= minSlope) trend = 'uptrend';
    else if (lastClose < sma && slope <= -minSlope) trend = 'downtrend';

    const distance = Math.abs(lastClose - sma) / sma;
    const strength = Math.min(1, (Math.abs(slope) / Math.max(minSlope, 1e-9)) * 0.5 +
        Math.min(distance * 20, 0.5));

    return {
        trend,
        strength,
        sma,
        slope,
        lastClose,
        explanation: `Context trend=${trend} via SMA(${period}).`,
    };
}

function recentSwingPoints(candles, lookback = 5) {
    if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) {
        return { swingHigh: null, swingLow: null };
    }
    const window = candles.slice(-(lookback * 2 + 1));
    const mid = lookback;
    const midCandle = window[mid];
    const left = window.slice(0, mid);
    const right = window.slice(mid + 1);
    const isSwingHigh = left.every((c) => c.high <= midCandle.high) &&
        right.every((c) => c.high <= midCandle.high);
    const isSwingLow = left.every((c) => c.low >= midCandle.low) &&
        right.every((c) => c.low >= midCandle.low);
    return {
        swingHigh: isSwingHigh ? midCandle.high : null,
        swingLow: isSwingLow ? midCandle.low : null,
    };
}

function contextMatches(requiredTrend, context) {
    if (!requiredTrend || requiredTrend === 'any') return true;
    if (context.trend === 'unknown') return false;
    return context.trend === requiredTrend;
}

function buildContext(candles, patternCandleCount, thresholds) {
    const before = candles.slice(0, candles.length - patternCandleCount);
    // Include the first pattern candle's prior history only — trend ends
    // at the bar immediately before the pattern starts.
    const context = detectTrend(before, thresholds);
    const swings = recentSwingPoints(before, 5);
    const last = before.at(-1);
    return {
        ...context,
        ...swings,
        priorCandle: last || null,
        priorMetrics: last ? candleMetrics(last) : null,
    };
}

module.exports = {
    detectTrend,
    recentSwingPoints,
    contextMatches,
    buildContext,
};
