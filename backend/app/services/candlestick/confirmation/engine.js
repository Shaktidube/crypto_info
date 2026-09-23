const {
    simpleMovingAverage,
    averageTrueRange,
    relativeStrengthIndex,
    stochasticK,
} = require('../../../utils/lib/candleIndicators');

/**
 * Optional indicator confirmation. Patterns remain valid geometrically even
 * when indicators disagree; confirmation only adjusts the evidence score.
 */
function buildConfirmation(candlesThroughSignal, direction, thresholds) {
    const atr = averageTrueRange(candlesThroughSignal, thresholds.atrPeriod);
    const volumes = candlesThroughSignal.map((c) => c.volume);
    const averageVolume = simpleMovingAverage(
        volumes.slice(0, -1),
        thresholds.volumeSmaPeriod,
    );
    const signal = candlesThroughSignal.at(-1);
    const volumeMultiplier = averageVolume && signal
        ? signal.volume / averageVolume
        : null;
    const rsi = relativeStrengthIndex(
        candlesThroughSignal,
        thresholds.rsiPeriod,
    );
    const stoch = stochasticK(candlesThroughSignal, thresholds.rsiPeriod);

    let rsiSupports = false;
    let stochSupports = false;
    if (direction === 'bullish') {
        rsiSupports = rsi != null && rsi <= thresholds.rsiOversold;
        stochSupports = stoch != null && stoch <= thresholds.rsiOversold;
    } else if (direction === 'bearish') {
        rsiSupports = rsi != null && rsi >= thresholds.rsiOverbought;
        stochSupports = stoch != null && stoch >= thresholds.rsiOverbought;
    }

    const volumeSupports = volumeMultiplier != null &&
        volumeMultiplier >= thresholds.confirmationMinVolumeMultiplier;

    const parts = [];
    if (rsi != null) parts.push(`RSI=${rsi.toFixed(1)}`);
    if (stoch != null) parts.push(`Stoch%K=${stoch.toFixed(1)}`);
    if (volumeMultiplier != null) {
        parts.push(`volx=${volumeMultiplier.toFixed(2)}`);
    }

    // Volume has its own scoring weight. Keep it out of indicator strength so
    // the same evidence is not counted twice in the final confidence score.
    const confirmBits = [rsiSupports, stochSupports]
        .filter(Boolean).length;
    const strength = confirmBits / 2;

    return {
        atr,
        averageVolume,
        volumeMultiplier,
        rsi,
        stochasticK: stoch,
        rsiSupports,
        stochSupports,
        volumeSupports,
        strength,
        explanation: parts.length
            ? `Indicators: ${parts.join(', ')}.`
            : 'Indicators unavailable.',
    };
}

module.exports = { buildConfirmation };
