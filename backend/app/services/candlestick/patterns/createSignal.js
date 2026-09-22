const { candleMetrics } = require('../metrics');
const { invalidationFromPattern } = require('../helpers');
const { scoreSignal } = require('../scoring/signalScorer');

function makeSignal({
    name,
    direction,
    type,
    candleCount,
    candles,
    geometry,
    context,
    contextMatched,
    confirmation,
    patternQuality,
    thresholds,
    explanation,
    confirmed = false,
    confirmationNote = '',
}) {
    const volumeStrength = confirmation?.volumeSupports
        ? Math.min(1, (confirmation.volumeMultiplier || 1) / 2)
        : 0;
    const scores = scoreSignal({
        patternQuality,
        contextStrength: context?.strength || 0,
        contextMatched,
        confirmationStrength: confirmation?.strength || 0,
        volumeStrength,
        weights: thresholds.score,
    });

    const candleList = Object.values(candles).filter(Boolean);
    return {
        patternName: name,
        direction,
        type,
        candleCount,
        confirmed,
        candles,
        geometry,
        metrics: {
            candles: candleList.map(candleMetrics),
            atr: confirmation?.atr ?? null,
            averageVolume: confirmation?.averageVolume ?? null,
            volumeMultiplier: confirmation?.volumeMultiplier ?? null,
            thresholds,
        },
        context: {
            trend: context?.trend,
            strength: context?.strength,
            matched: contextMatched,
            sma: context?.sma,
            explanation: context?.explanation,
        },
        confirmation: {
            ...confirmation,
            note: confirmationNote,
        },
        scores,
        confidence: scores.confidence,
        invalidation: invalidationFromPattern(direction, candleList),
        explanation,
        // Analytical only — never implies order placement.
        tradeAction: 'none',
    };
}

module.exports = { makeSignal };
