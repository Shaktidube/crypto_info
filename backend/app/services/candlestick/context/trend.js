const {
    simpleMovingAverage,
    averageTrueRange,
} = require('../../../utils/lib/candleIndicators');
const { candleMetrics } = require('../metrics');

function unavailableTrend(explanation, requiredBars = 0, barsAnalyzed = 0) {
    return {
        trend: 'unknown',
        strength: 0,
        sma: null,
        fastSma: null,
        slowSma: null,
        slope: null,
        normalizedMoveAtr: null,
        efficiencyRatio: null,
        structure: 'unknown',
        evidence: { up: 0, down: 0, required: 0, total: 5 },
        requiredBars,
        barsAnalyzed,
        explanation,
    };
}

function directionalEfficiency(closes, lookback) {
    const window = closes.slice(-(lookback + 1));
    if (window.length < lookback + 1) return null;
    const netMove = window.at(-1) - window[0];
    let travelled = 0;
    for (let i = 1; i < window.length; i += 1) {
        travelled += Math.abs(window[i] - window[i - 1]);
    }
    return {
        netMove,
        ratio: travelled > 0 ? Math.abs(netMove) / travelled : 0,
    };
}

function detectStructure(candles, lookback) {
    const window = candles.slice(-lookback);
    if (window.length < 4) return 'unknown';
    const midpoint = Math.floor(window.length / 2);
    const earlier = window.slice(0, midpoint);
    const recent = window.slice(midpoint);
    const average = (rows, key) => rows.reduce(
        (sum, candle) => sum + candle[key], 0,
    ) / rows.length;
    const priorHigh = average(earlier, 'high');
    const priorLow = average(earlier, 'low');
    const recentHigh = average(recent, 'high');
    const recentLow = average(recent, 'low');
    if (recentHigh > priorHigh && recentLow > priorLow) return 'higher';
    if (recentHigh < priorHigh && recentLow < priorLow) return 'lower';
    return 'mixed';
}

/**
 * Detect the trend that existed before a pattern began.
 *
 * A single SMA check is too fragile on short crypto timeframes, so the trend
 * needs agreement from five independent pieces of evidence:
 * price/SMA, fast/slow SMA alignment, slow-SMA slope, ATR-normalized movement,
 * and higher/lower market structure. No pattern or future candle is read.
 */
function detectTrend(candlesBeforePattern, thresholds) {
    const slowPeriod = thresholds.trendSmaPeriod;
    const fastPeriod = Math.min(thresholds.trendFastSmaPeriod, slowPeriod);
    const lookback = thresholds.trendLookbackPeriod;
    const atrPeriod = thresholds.trendAtrPeriod;
    const requiredBars = Math.max(slowPeriod + 1, lookback + 1, atrPeriod + 1);
    const barsAnalyzed = Array.isArray(candlesBeforePattern)
        ? candlesBeforePattern.length
        : 0;
    if (!Array.isArray(candlesBeforePattern) ||
        candlesBeforePattern.length < requiredBars) {
        return unavailableTrend(
            `Insufficient prior history (${barsAnalyzed}/${requiredBars} bars).`,
            requiredBars,
            barsAnalyzed,
        );
    }

    const closes = candlesBeforePattern.map((candle) => candle.close);
    const slowSma = simpleMovingAverage(closes, slowPeriod);
    const priorSlowSma = simpleMovingAverage(closes.slice(0, -1), slowPeriod);
    const fastSma = simpleMovingAverage(closes, fastPeriod);
    const atr = averageTrueRange(candlesBeforePattern, atrPeriod);
    const movement = directionalEfficiency(closes, lookback);
    const lastClose = closes.at(-1);
    if (![slowSma, priorSlowSma, fastSma, lastClose]
        .every(Number.isFinite) || !movement) {
        return unavailableTrend(
            'Prior trend inputs are unavailable.',
            requiredBars,
            barsAnalyzed,
        );
    }

    const slope = slowSma === 0 ? 0 : (slowSma - priorSlowSma) / slowSma;
    const normalizedMoveAtr = atr > 0 ? movement.netMove / atr : 0;
    const structure = detectStructure(candlesBeforePattern, lookback);
    const minSlope = thresholds.trendMinSlopePercent;
    const minMoveAtr = thresholds.trendMinMoveAtr;
    const minEfficiency = thresholds.trendMinEfficiencyRatio;
    const minEvidence = thresholds.trendMinEvidence;
    const efficient = movement.ratio >= minEfficiency;

    const upChecks = [
        lastClose > slowSma,
        fastSma > slowSma,
        slope >= minSlope,
        efficient && normalizedMoveAtr >= minMoveAtr,
        structure === 'higher',
    ];
    const downChecks = [
        lastClose < slowSma,
        fastSma < slowSma,
        slope <= -minSlope,
        efficient && normalizedMoveAtr <= -minMoveAtr,
        structure === 'lower',
    ];
    const upEvidence = upChecks.filter(Boolean).length;
    const downEvidence = downChecks.filter(Boolean).length;
    let trend = 'sideways';
    let winningEvidence = Math.max(upEvidence, downEvidence);
    if (upEvidence >= minEvidence && upEvidence > downEvidence) {
        trend = 'uptrend';
        winningEvidence = upEvidence;
    } else if (downEvidence >= minEvidence && downEvidence > upEvidence) {
        trend = 'downtrend';
        winningEvidence = downEvidence;
    }

    const evidenceStrength = winningEvidence / upChecks.length;
    const efficiencyStrength = Math.min(1, movement.ratio);
    const moveStrength = Math.min(1,
        Math.abs(normalizedMoveAtr) / Math.max(minMoveAtr * 2, 1e-9),
    );
    const strength = trend === 'sideways'
        ? 0
        : Math.min(1,
            (evidenceStrength * 0.6) +
            (efficiencyStrength * 0.2) +
            (moveStrength * 0.2),
        );

    return {
        trend,
        strength,
        // Keep `sma` and `slope` for backward-compatible alert consumers.
        sma: slowSma,
        fastSma,
        slowSma,
        slope,
        lastClose,
        atr,
        normalizedMoveAtr,
        efficiencyRatio: movement.ratio,
        structure,
        evidence: {
            up: upEvidence,
            down: downEvidence,
            required: minEvidence,
            total: upChecks.length,
        },
        requiredBars,
        barsAnalyzed,
        explanation: `Prior trend=${trend}; evidence up ${upEvidence}/5, ` +
            `down ${downEvidence}/5; structure=${structure}; ` +
            `move=${normalizedMoveAtr.toFixed(2)} ATR; ` +
            `efficiency=${movement.ratio.toFixed(2)}.`,
    };
}

/** Return the most recent confirmed swing high and low before the pattern. */
function recentSwingPoints(candles, radius = 2) {
    if (!Array.isArray(candles) || candles.length < radius * 2 + 1) {
        return { swingHigh: null, swingLow: null };
    }
    let swingHigh = null;
    let swingLow = null;
    for (let i = candles.length - radius - 1; i >= radius; i -= 1) {
        const candidate = candles[i];
        const neighbors = candles.slice(i - radius, i)
            .concat(candles.slice(i + 1, i + radius + 1));
        if (swingHigh == null &&
            neighbors.every((candle) => candle.high <= candidate.high)) {
            swingHigh = candidate.high;
        }
        if (swingLow == null &&
            neighbors.every((candle) => candle.low >= candidate.low)) {
            swingLow = candidate.low;
        }
        if (swingHigh != null && swingLow != null) break;
    }
    return { swingHigh, swingLow };
}

function contextMatches(requiredTrend, context) {
    if (!requiredTrend || requiredTrend === 'any') return true;
    if (context.trend === 'unknown') return false;
    return context.trend === requiredTrend;
}

function buildContext(candles, patternCandleCount, thresholds) {
    const before = candles.slice(0, candles.length - patternCandleCount);
    const context = detectTrend(before, thresholds);
    const swings = recentSwingPoints(before, thresholds.trendSwingRadius);
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
