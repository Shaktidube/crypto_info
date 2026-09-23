const { mergeThresholds } = require('./thresholds');
const { candleMetrics } = require('./metrics');
const { buildContext } = require('./context/trend');
const { buildConfirmation } = require('./confirmation/engine');
const { scoreSignal } = require('./scoring/signalScorer');
const { detectSingles } = require('./patterns/single');
const { detectDoubles, detectBearishHarami } = require('./patterns/double');
const { detectTriples } = require('./patterns/triple');
const {
    attachTradePlan,
    isHighQualitySignal,
    DEFAULT_PREMIUM,
} = require('./risk/tradePlan');
const { allowsTradeSide, signalTradeSide } = require('./tradeSideMode');

function enrichSignal(signal, throughSignal, thresholds, riskOptions = {}) {
    const confirmation = buildConfirmation(
        throughSignal,
        signal.direction,
        thresholds,
    );
    const volumeStrength = confirmation.volumeSupports
        ? Math.min(1, (confirmation.volumeMultiplier || 1) / 2)
        : 0;
    const scores = scoreSignal({
        patternQuality: signal.scores.patternQuality,
        contextStrength: signal.context.strength || 0,
        contextMatched: signal.context.matched,
        confirmationStrength: confirmation.strength,
        volumeStrength,
        weights: thresholds.score,
    });
    const enriched = {
        ...signal,
        confirmation: {
            ...confirmation,
            note: signal.confirmation?.note || '',
        },
        scores,
        confidence: scores.confidence,
        metrics: {
            ...signal.metrics,
            atr: confirmation.atr,
            averageVolume: confirmation.averageVolume,
            volumeMultiplier: confirmation.volumeMultiplier,
        },
    };
    return attachTradePlan(enriched, riskOptions) || enriched;
}

function confirmPriorDouble(signal, confirmationCandle) {
    if (!signal || !confirmationCandle || signal.candleCount !== 2) {
        return null;
    }
    const confirms = signal.direction === 'bullish'
        ? confirmationCandle.close > signal.candles.c2.high &&
            confirmationCandle.close > confirmationCandle.open
        : signal.direction === 'bearish'
            ? confirmationCandle.close < signal.candles.c2.low &&
                confirmationCandle.close < confirmationCandle.open
            : false;
    if (!confirms) return null;
    const note = 'Next closed candle confirmed beyond the pattern high/low.';
    return {
        ...signal,
        confirmed: true,
        candles: { ...signal.candles, c3: confirmationCandle },
        metrics: {
            ...signal.metrics,
            candles: [
                signal.candles.c1,
                signal.candles.c2,
                confirmationCandle,
            ].map(candleMetrics),
        },
        confirmation: { ...signal.confirmation, note },
        explanation: `${signal.explanation} ${note}`,
    };
}

/**
 * Analyze closed OHLCV history ending at the latest closed bar.
 * Never reads future candles: only candles[0..end] are used.
 *
 * Layers:
 *   geometry → context → confirmation → scored signal → trade plan
 */
function analyzeCandles(candles, options = {}) {
    const thresholds = mergeThresholds(options.thresholds || options);
    const requireContextMatch = options.requireContextMatch === true;
    const enabled = options.enabledPatterns
        ? new Set(options.enabledPatterns.map((name) => name.toLowerCase()))
        : null;
    const riskOptions = options.riskOptions || {};
    const highQualityOnly = options.highQualityOnly === true;
    const requirePriceConfirmation = options.requirePriceConfirmation === true;
    const qualityOptions = options.qualityOptions || {};
    const tradeSideMode = options.tradeSideMode || 'both';

    if (!Array.isArray(candles) || candles.length < 1) {
        return { signals: [], thresholds };
    }

    // Only closed candles participate — forming bar must not signal.
    const closed = candles.filter((c) => c && c.closed === true);
    if (!closed.length) return { signals: [], thresholds };

    const maxCount = 3;
    const signals = [];

    for (const candleCount of [1, 2, 3]) {
        if (closed.length < candleCount) continue;
        const context = buildContext(closed, candleCount, thresholds);
        const confirmationStub = buildConfirmation(
            closed, 'neutral', thresholds,
        );
        const args = { thresholds, context, confirmation: confirmationStub };
        let found = [];
        if (candleCount === 1) found = detectSingles(closed, args);
        if (candleCount === 2) found = detectDoubles(closed, args);
        if (candleCount === 3) found = detectTriples(closed, args);

        for (const signal of found) {
            if (requirePriceConfirmation && signal.candleCount < 3) continue;
            if (requireContextMatch && !signal.context.matched) continue;
            if (enabled && !enabled.has(signal.patternName.toLowerCase())) {
                continue;
            }
            const enriched = enrichSignal(
                signal, closed, thresholds, riskOptions,
            );
            if (highQualityOnly &&
                !isHighQualitySignal(enriched, qualityOptions)) {
                continue;
            }
            if (!allowsTradeSide(tradeSideMode, signalTradeSide(enriched))) {
                continue;
            }
            signals.push(enriched);
        }
    }

    // When precision is preferred over immediacy, re-check a two-candle
    // pattern that ended one bar ago and emit it only after a third closed bar
    // breaks the pattern in the expected direction.
    if (requirePriceConfirmation && closed.length >= 3) {
        const beforeConfirmation = closed.slice(0, -1);
        const context = buildContext(beforeConfirmation, 2, thresholds);
        const confirmationStub = buildConfirmation(
            beforeConfirmation, 'neutral', thresholds,
        );
        const priorSignals = detectDoubles(beforeConfirmation, {
            thresholds,
            context,
            confirmation: confirmationStub,
        });
        for (const priorSignal of priorSignals) {
            const signal = confirmPriorDouble(priorSignal, closed.at(-1));
            if (!signal) continue;
            if (requireContextMatch && !signal.context.matched) continue;
            if (enabled && !enabled.has(signal.patternName.toLowerCase())) {
                continue;
            }
            const enriched = enrichSignal(
                signal, closed, thresholds, riskOptions,
            );
            if (highQualityOnly &&
                !isHighQualitySignal(enriched, qualityOptions)) {
                continue;
            }
            if (!allowsTradeSide(tradeSideMode, signalTradeSide(enriched))) {
                continue;
            }
            signals.push(enriched);
        }
    }

    signals.sort((a, b) =>
        b.confidence - a.confidence ||
        Number(b.confirmed) - Number(a.confirmed) ||
        b.candleCount - a.candleCount);

    return {
        signals,
        thresholds,
        asOfOpenTime: closed.at(-1)?.openTime ?? null,
        candleCountAnalyzed: closed.length,
        maxPatternWidth: maxCount,
    };
}

function analyzeForAlert(candles, options = {}) {
    const result = analyzeCandles(candles, {
        requireContextMatch: options.requireContextMatch !== false,
        enabledPatterns: options.enabledPatterns,
        thresholds: options.thresholds,
        highQualityOnly: options.highQualityOnly === true,
        requirePriceConfirmation: options.requirePriceConfirmation === true,
        qualityOptions: options.qualityOptions,
        riskOptions: options.riskOptions,
        tradeSideMode: options.tradeSideMode || 'both',
    });
    const top = result.signals[0] || null;
    if (!top) return null;
    if (Number.isFinite(options.minConfidence) &&
        top.confidence < options.minConfidence) {
        return null;
    }
    return top;
}

module.exports = {
    analyzeCandles,
    analyzeForAlert,
    candleMetrics,
    detectBearishHarami,
    mergeThresholds,
    isHighQualitySignal,
    attachTradePlan,
    DEFAULT_PREMIUM,
    allowsTradeSide,
    signalTradeSide,
};
