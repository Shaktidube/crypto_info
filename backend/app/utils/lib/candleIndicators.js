function simpleMovingAverage(values, period) {
    const valid = values.filter(Number.isFinite);
    if (valid.length < period) return null;
    const window = valid.slice(-period);
    return window.reduce((sum, value) => sum + value, 0) / period;
}

function averageTrueRange(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;
    const source = candles.slice(-(period + 1));
    const trueRanges = [];
    for (let i = 1; i < source.length; i += 1) {
        const current = source[i];
        const previous = source[i - 1];
        trueRanges.push(Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close),
        ));
    }
    return simpleMovingAverage(trueRanges, period);
}

/**
 * Wilder RSI. Uses only candles up to and including the last bar (no look-ahead).
 * Returns null until enough history exists.
 */
function relativeStrengthIndex(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;
    const closes = candles.map((candle) => candle.close);
    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= period; i += 1) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gainSum += change;
        else lossSum -= change;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    for (let i = period + 1; i < closes.length; i += 1) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

/**
 * Stochastic %K (slow enough for confirmation). Uses highs/lows over period.
 */
function stochasticK(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period) return null;
    const window = candles.slice(-period);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest = Math.min(...window.map((c) => c.low));
    const range = highest - lowest;
    if (range <= 0) return 50;
    const close = window.at(-1).close;
    return ((close - lowest) / range) * 100;
}

module.exports = {
    simpleMovingAverage,
    averageTrueRange,
    relativeStrengthIndex,
    stochasticK,
};
