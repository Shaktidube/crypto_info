/**
 * Reusable OHLC measurements derived from a single closed candle.
 * Range of 0 is treated as invalid for ratio-based rules.
 */
function candleMetrics(candle) {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const body = Math.abs(close - open);
    const range = high - low;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const midpoint = (open + close) / 2;
    const direction = close > open ? 'bullish'
        : close < open ? 'bearish'
            : 'neutral';

    return {
        open,
        high,
        low,
        close,
        body,
        range,
        upperWick,
        lowerWick,
        midpoint,
        direction,
        isBullish: direction === 'bullish',
        isBearish: direction === 'bearish',
        bodyToRange: range > 0 ? body / range : 0,
        // Alias retained for legacy scanner metrics consumers.
        bodyPercent: range > 0 ? body / range : 0,
        upperWickToBody: body > 0 ? upperWick / body : (upperWick > 0 ? Infinity : 0),
        lowerWickToBody: body > 0 ? lowerWick / body : (lowerWick > 0 ? Infinity : 0),
        upperWickToRange: range > 0 ? upperWick / range : 0,
        lowerWickToRange: range > 0 ? lowerWick / range : 0,
        // Body center as fraction of range (0 = at low, 1 = at high).
        bodyCenterInRange: range > 0
            ? ((Math.max(open, close) + Math.min(open, close)) / 2 - low) / range
            : 0.5,
    };
}

function isFiniteOhlcv(candle) {
    return Boolean(candle) &&
        [candle.open, candle.high, candle.low, candle.close, candle.volume]
            .every(Number.isFinite);
}

function isClosedCandle(candle) {
    return Boolean(candle) && candle.closed === true;
}

function averageRange(candles, lookback) {
    const window = candles.slice(-lookback);
    if (!window.length) return null;
    const ranges = window
        .map((candle) => candleMetrics(candle).range)
        .filter((range) => range > 0);
    if (!ranges.length) return null;
    return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function isRelativelyLong(candle, priorCandles, thresholds) {
    const metrics = candleMetrics(candle);
    if (metrics.range <= 0) return false;
    if (metrics.bodyToRange < thresholds.longBodyMinPercent) return false;
    const avg = averageRange(priorCandles, thresholds.relativeSizeLookback);
    if (avg == null) return metrics.bodyToRange >= thresholds.longBodyMinPercent;
    return metrics.range >= thresholds.longRelativeToAvgRange * avg;
}

module.exports = {
    candleMetrics,
    isFiniteOhlcv,
    isClosedCandle,
    averageRange,
    isRelativelyLong,
};
