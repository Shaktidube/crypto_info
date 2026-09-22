const {
    candleMetrics,
    isFiniteOhlcv,
} = require('../../metrics');
const {
    takeLastClosed,
    bodyContainsBody,
    bodyEngulfsBody,
    rangeEngulfsRange,
    rangeContainsRange,
    gapDirection,
    isDoji,
    almostEqual,
    explain,
} = require('../../helpers');
const { contextMatches } = require('../../context/trend');
const { makeSignal } = require('../createSignal');
const { averageTrueRange, simpleMovingAverage } =
    require('../../../../utils/lib/candleIndicators');

function validPair(c1, c2) {
    return [c1, c2].every((c) => isFiniteOhlcv(c) && c.closed === true) &&
        candleMetrics(c1).range > 0 && candleMetrics(c2).range > 0;
}

function detectDoubles(candles, { thresholds, context, confirmation }) {
    const slice = takeLastClosed(candles, 2);
    if (!slice) return [];
    const [c1, c2] = slice;
    if (!validPair(c1, c2)) return [];

    const m1 = candleMetrics(c1);
    const m2 = candleMetrics(c2);
    const signals = [];
    const push = (spec) => {
        const matched = contextMatches(spec.requiredTrend, context);
        signals.push(makeSignal({
            name: spec.name,
            direction: spec.direction,
            type: spec.type,
            candleCount: 2,
            candles: { c1, c2 },
            geometry: { c1: m1, c2: m2 },
            context,
            contextMatched: matched,
            confirmation,
            patternQuality: spec.quality,
            thresholds,
            confirmed: false,
            explanation: explain([
                spec.note,
                matched
                    ? `Context ${context.trend} supports interpretation.`
                    : `Context ${context.trend} does not match required ${spec.requiredTrend}.`,
                confirmation?.explanation,
            ]),
        }));
    };

    // Bullish engulfing — Rhoads: dark setup, white signal covering body+range.
    if (m1.isBearish && m2.isBullish &&
        bodyEngulfsBody(c2, c1) &&
        (!thresholds.engulfingRequireRangeCover || rangeEngulfsRange(c2, c1))) {
        push({
            name: 'Bullish Engulfing',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: Math.min(1, m2.body / Math.max(m1.body, 1e-9) / 2),
            note: 'Bullish candle engulfs prior bearish candle body and range.',
        });
    }

    // Bearish engulfing
    if (m1.isBullish && m2.isBearish &&
        bodyEngulfsBody(c2, c1) &&
        (!thresholds.engulfingRequireRangeCover || rangeEngulfsRange(c2, c1))) {
        push({
            name: 'Bearish Engulfing',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: Math.min(1, m2.body / Math.max(m1.body, 1e-9) / 2),
            note: 'Bearish candle engulfs prior bullish candle body and range.',
        });
    }

    // Bullish harami — body of signal inside body of setup (book focuses on O/C).
    if (m1.isBearish && m2.isBullish &&
        m2.body <= thresholds.haramiMaxInnerBodyRatio * m1.body &&
        bodyContainsBody(c1, c2, m1.body * thresholds.haramiBodyTolerancePercent)) {
        push({
            name: 'Bullish Harami',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.55,
            note: 'Small bullish body inside prior long bearish body.',
        });
    }

    // Bearish harami — geometric (book). Quality filters live in legacy detector.
    if (m1.isBullish && m2.isBearish &&
        m2.body <= thresholds.haramiMaxInnerBodyRatio * m1.body &&
        bodyContainsBody(c1, c2, m1.body * thresholds.haramiBodyTolerancePercent)) {
        push({
            name: 'Bearish Harami',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.55,
            note: 'Small bearish body inside prior long bullish body.',
        });
    }

    // Harami cross — inner day is a doji.
    if (m1.isBearish && isDoji(m2, thresholds) &&
        bodyContainsBody(c1, c2, m1.body * thresholds.haramiBodyTolerancePercent)) {
        push({
            name: 'Bullish Harami Cross',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.6,
            note: 'Doji contained in prior bearish body.',
        });
    }
    if (m1.isBullish && isDoji(m2, thresholds) &&
        bodyContainsBody(c1, c2, m1.body * thresholds.haramiBodyTolerancePercent)) {
        push({
            name: 'Bearish Harami Cross',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.6,
            note: 'Doji contained in prior bullish body.',
        });
    }

    // Piercing line — gap below prior low; close above midpoint of setup.
    if (m1.isBearish && m2.isBullish &&
        m1.bodyToRange >= thresholds.piercingMinBodyPercent &&
        m2.bodyToRange >= thresholds.piercingMinBodyPercent &&
        c2.open < c1.low &&
        c2.close > m1.midpoint &&
        c2.close < c1.open) {
        push({
            name: 'Piercing Line',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.65,
            note: 'Gap-down open then close above midpoint of prior black body.',
        });
    }

    // Dark cloud cover — gap above prior high; close below midpoint.
    if (m1.isBullish && m2.isBearish &&
        m1.bodyToRange >= thresholds.piercingMinBodyPercent &&
        m2.bodyToRange >= thresholds.piercingMinBodyPercent &&
        c2.open > c1.high &&
        c2.close < m1.midpoint &&
        c2.close > c1.open) {
        push({
            name: 'Dark Cloud Cover',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.65,
            note: 'Gap-up open then close below midpoint of prior white body.',
        });
    }

    // Meeting lines — opposite long candles with nearly equal closes.
    const closeTol = Math.max(m1.range, m2.range) *
        thresholds.meetingLineMaxCloseDiffToRange;
    if (m1.isBearish && m2.isBullish &&
        almostEqual(c1.close, c2.close, closeTol) &&
        gapDirection(c1, c2) === 'down') {
        push({
            name: 'Bullish Meeting Lines',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.5,
            note: 'Long black then long white closing near the same price.',
        });
    }
    if (m1.isBullish && m2.isBearish &&
        almostEqual(c1.close, c2.close, closeTol) &&
        gapDirection(c1, c2) === 'up') {
        push({
            name: 'Bearish Meeting Lines',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.5,
            note: 'Long white then long black closing near the same price.',
        });
    }

    return signals;
}

/**
 * Legacy scanner-compatible Bearish Harami with volume/ATR/confirmation.
 * Preserves prior project behavior (not pure book geometry).
 */
function detectBearishHaramiLegacy(candles, suppliedOptions = {}) {
    const options = {
        requireConfirmation: true,
        minImpulseBodyPercent: 0.55,
        minAtrMultiplier: 0.60,
        minVolumeMultiplier: 1.20,
        maxInnerBodyRatio: 0.50,
        bodyTolerancePercent: 0.05,
        ...suppliedOptions,
    };
    const required = options.requireConfirmation ? 3 : 2;
    if (!Array.isArray(candles) || candles.length < required) return null;

    const c3 = options.requireConfirmation ? candles.at(-1) : null;
    const c2 = candles.at(options.requireConfirmation ? -2 : -1);
    const c1 = candles.at(options.requireConfirmation ? -3 : -2);
    const patternCandles = [c1, c2, ...(c3 ? [c3] : [])];
    if (patternCandles.some((candle) => !candle || candle.closed !== true)) {
        return null;
    }
    if (patternCandles.some((candle) => !isFiniteOhlcv(candle))) return null;

    const c1Metrics = candleMetrics(c1);
    const c2Metrics = candleMetrics(c2);
    if (c1Metrics.range <= 0 || c2Metrics.range <= 0 || c2.volume <= 0) {
        return null;
    }

    const contextEnd = candles.length - required;
    const context = candles.slice(0, contextEnd + 1);
    const atr = averageTrueRange(context, 14);
    const averageVolume = simpleMovingAverage(
        candles.slice(0, contextEnd).map((candle) => candle.volume),
        20,
    );
    const volumeMultiplier = averageVolume ? c1.volume / averageVolume : null;
    const tolerance = c1Metrics.body * options.bodyTolerancePercent;
    const c1Midpoint = (c1.open + c1.close) / 2;

    const isImpulse = c1.close > c1.open &&
        c1Metrics.bodyToRange >= options.minImpulseBodyPercent &&
        (atr == null || c1Metrics.body >= options.minAtrMultiplier * atr) &&
        (averageVolume == null ||
            volumeMultiplier >= options.minVolumeMultiplier);
    const isInnerBearish = c2.close < c2.open &&
        c2.open <= c1.close + tolerance &&
        c2.close >= c1.open - tolerance &&
        c2Metrics.body <= options.maxInnerBodyRatio * c1Metrics.body &&
        c2Metrics.bodyToRange >= 0.15 && c2Metrics.bodyToRange <= 0.70;
    const isConfirmed = !c3 || (
        c3.close < c3.open &&
        (c3.close < c2.low || c3.close < c1Midpoint)
    );

    if (!isImpulse || !isInnerBearish || !isConfirmed) return null;
    return {
        patternName: 'Bearish Harami',
        confirmed: Boolean(c3),
        candles: { c1, c2, c3 },
        metrics: {
            atr,
            averageVolume,
            volumeMultiplier,
            volumeFilterPassed: averageVolume == null ||
                volumeMultiplier >= options.minVolumeMultiplier,
            c1: c1Metrics,
            c2: c2Metrics,
            thresholds: options,
        },
    };
}

// Adapt candleMetrics output: legacy used bodyPercent alias
function withBodyPercent(metrics) {
    return { ...metrics, bodyPercent: metrics.bodyToRange };
}

// Patch legacy to use bodyPercent field expected by old return shape
const _legacy = detectBearishHaramiLegacy;
function detectBearishHarami(candles, suppliedOptions = {}) {
    const result = _legacy(candles, suppliedOptions);
    if (!result) return null;
    result.metrics.c1 = withBodyPercent(result.metrics.c1);
    result.metrics.c2 = withBodyPercent(result.metrics.c2);
    return result;
}

module.exports = {
    detectDoubles,
    detectBearishHarami,
    rangeContainsRange,
};
