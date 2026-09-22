const { candleMetrics, isClosedCandle, isFiniteOhlcv } = require('../../metrics');
const { isDoji, takeLastClosed, explain } = require('../../helpers');
const { contextMatches } = require('../../context/trend');
const { makeSignal } = require('../createSignal');

function detectSingleShapes(candle, thresholds) {
    const m = candleMetrics(candle);
    if (m.range <= 0) return [];

    const shapes = [];

    if (m.isBullish &&
        m.lowerWickToRange <= thresholds.marubozuMaxWickToRange &&
        (m.upperWickToRange <= thresholds.marubozuMaxWickToRange ||
            m.close === m.high)) {
        shapes.push({
            name: 'White Marubozu',
            direction: 'bullish',
            type: 'continuation_or_reversal',
            requiredTrend: 'any',
            quality: Math.min(1, m.bodyToRange),
            note: 'Bullish long white / marubozu-style candle.',
        });
    }

    if (m.isBearish &&
        m.upperWickToRange <= thresholds.marubozuMaxWickToRange &&
        (m.lowerWickToRange <= thresholds.marubozuMaxWickToRange ||
            m.close === m.low)) {
        shapes.push({
            name: 'Black Marubozu',
            direction: 'bearish',
            type: 'continuation_or_reversal',
            requiredTrend: 'any',
            quality: Math.min(1, m.bodyToRange),
            note: 'Bearish long black / marubozu-style candle.',
        });
    }

    if (isDoji(m, thresholds)) {
        const nearHigh = m.bodyCenterInRange >= 0.7;
        const nearLow = m.bodyCenterInRange <= 0.3;
        if (nearHigh && m.lowerWickToRange >= 0.6) {
            shapes.push({
                name: 'Dragonfly Doji',
                direction: 'bullish',
                type: 'reversal',
                requiredTrend: 'downtrend',
                quality: 0.7,
                note: 'Doji with open/close near high and long lower wick.',
            });
        } else if (nearLow && m.upperWickToRange >= 0.6) {
            shapes.push({
                name: 'Gravestone Doji',
                direction: 'bearish',
                type: 'reversal',
                requiredTrend: 'uptrend',
                quality: 0.7,
                note: 'Doji with open/close near low and long upper wick.',
            });
        } else if (m.upperWickToRange >= 0.3 && m.lowerWickToRange >= 0.3) {
            shapes.push({
                name: 'Long-Legged Doji',
                direction: 'neutral',
                type: 'indecision',
                requiredTrend: 'any',
                quality: 0.55,
                note: 'Doji with extended wicks on both sides.',
            });
        } else {
            shapes.push({
                name: 'Doji',
                direction: 'neutral',
                type: 'indecision',
                requiredTrend: 'any',
                quality: 0.45,
                note: 'Open approximately equal to close.',
            });
        }
    }

    if (m.bodyToRange <= thresholds.spinningTopMaxBodyToRange &&
        m.upperWickToBody >= thresholds.spinningTopMinWickToBody &&
        m.lowerWickToBody >= thresholds.spinningTopMinWickToBody &&
        Math.abs(m.bodyCenterInRange - 0.5) <=
            thresholds.spinningTopMaxBodyCenterOffset) {
        shapes.push({
            name: 'Spinning Top',
            direction: m.isBullish ? 'bullish' : m.isBearish ? 'bearish' : 'neutral',
            type: 'indecision',
            requiredTrend: 'any',
            quality: 0.5,
            note: 'Small centered body with wicks at least as long as the body.',
        });
    }

    const hammerShape = m.bodyToRange <= thresholds.hammerMaxBodyToRange &&
        m.lowerWickToBody >= thresholds.hammerMinLowerWickToBody &&
        m.upperWickToBody <= thresholds.hammerMaxUpperWickToBody + 1e-9 &&
        m.upperWickToRange <= thresholds.hammerMaxUpperWickToRange;
    if (hammerShape) {
        shapes.push({
            name: 'Hammer Shape',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            resolvedNameInUptrend: 'Hanging Man',
            quality: Math.min(1, m.lowerWickToBody / 4),
            note: 'Small body near top of range with long lower wick.',
        });
    }

    if (m.isBullish &&
        m.lowerWickToRange <= thresholds.beltHoldMaxOpenWickToRange &&
        m.bodyToRange >= thresholds.beltHoldMinBodyToRange) {
        shapes.push({
            name: 'Bullish Belt Hold',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: m.bodyToRange,
            note: 'Opens near low and closes near high in a prior downtrend.',
        });
    }

    if (m.isBearish &&
        m.upperWickToRange <= thresholds.beltHoldMaxOpenWickToRange &&
        m.bodyToRange >= thresholds.beltHoldMinBodyToRange) {
        shapes.push({
            name: 'Bearish Belt Hold',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: m.bodyToRange,
            note: 'Opens near high and closes near low in a prior uptrend.',
        });
    }

    return shapes.map((shape) => ({ ...shape, metrics: m }));
}

function detectSingles(candles, { thresholds, context, confirmation }) {
    const slice = takeLastClosed(candles, 1);
    if (!slice) return [];
    const [candle] = slice;
    if (!isFiniteOhlcv(candle) || !isClosedCandle(candle)) return [];

    const signals = [];
    for (const shape of detectSingleShapes(candle, thresholds)) {
        let name = shape.name;
        let direction = shape.direction;
        let requiredTrend = shape.requiredTrend;

        if (shape.name === 'Hammer Shape') {
            if (context.trend === 'uptrend') {
                name = 'Hanging Man';
                direction = 'bearish';
                requiredTrend = 'uptrend';
            } else {
                name = 'Hammer';
                direction = 'bullish';
                requiredTrend = 'downtrend';
            }
        }

        const matched = contextMatches(requiredTrend, context);
        signals.push(makeSignal({
            name,
            direction,
            type: shape.type,
            candleCount: 1,
            candles: { c1: candle },
            geometry: shape.metrics,
            context,
            contextMatched: matched,
            confirmation,
            patternQuality: shape.quality,
            thresholds,
            explanation: explain([
                shape.note,
                matched
                    ? `Context ${context.trend} supports interpretation.`
                    : `Context ${context.trend} does not match required ${requiredTrend}.`,
                confirmation?.explanation,
            ]),
        }));
    }
    return signals;
}

module.exports = { detectSingles, detectSingleShapes };
