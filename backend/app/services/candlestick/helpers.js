const { candleMetrics } = require('./metrics');

function almostEqual(a, b, absTol) {
    return Math.abs(a - b) <= absTol;
}

function isDoji(metrics, thresholds) {
    return metrics.range > 0 &&
        metrics.bodyToRange <= thresholds.dojiMaxBodyToRange;
}

/** Gap up: current open above prior high. Gap down: current open below prior low. */
function gapDirection(prior, current) {
    if (current.open > prior.high) return 'up';
    if (current.open < prior.low) return 'down';
    return 'none';
}

function bodyContainsBody(outer, inner, tolerance = 0) {
    const outerTop = Math.max(outer.open, outer.close) + tolerance;
    const outerBottom = Math.min(outer.open, outer.close) - tolerance;
    const innerTop = Math.max(inner.open, inner.close);
    const innerBottom = Math.min(inner.open, inner.close);
    return innerTop <= outerTop && innerBottom >= outerBottom;
}

function rangeContainsRange(outer, inner) {
    return inner.high <= outer.high && inner.low >= outer.low;
}

function bodyEngulfsBody(outer, inner) {
    return Math.max(outer.open, outer.close) > Math.max(inner.open, inner.close) &&
        Math.min(outer.open, outer.close) < Math.min(inner.open, inner.close);
}

function rangeEngulfsRange(outer, inner) {
    return outer.high > inner.high && outer.low < inner.low;
}

function takeLastClosed(candles, count) {
    if (!Array.isArray(candles) || candles.length < count) return null;
    const slice = candles.slice(-count);
    if (slice.some((candle) => candle?.closed !== true)) return null;
    return slice;
}

function invalidationFromPattern(direction, patternCandles) {
    const lows = patternCandles.map((c) => c.low);
    const highs = patternCandles.map((c) => c.high);
    if (direction === 'bullish') {
        return { type: 'below_pattern_low', price: Math.min(...lows) };
    }
    if (direction === 'bearish') {
        return { type: 'above_pattern_high', price: Math.max(...highs) };
    }
    return { type: 'none', price: null };
}

function explain(parts) {
    return parts.filter(Boolean).join(' ');
}

module.exports = {
    almostEqual,
    isDoji,
    gapDirection,
    bodyContainsBody,
    rangeContainsRange,
    bodyEngulfsBody,
    rangeEngulfsRange,
    takeLastClosed,
    invalidationFromPattern,
    explain,
    candleMetrics,
};
