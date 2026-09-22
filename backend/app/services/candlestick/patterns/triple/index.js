const { candleMetrics, isFiniteOhlcv } = require('../../metrics');
const {
    takeLastClosed,
    bodyContainsBody,
    bodyEngulfsBody,
    rangeEngulfsRange,
    gapDirection,
    isDoji,
    explain,
} = require('../../helpers');
const { contextMatches } = require('../../context/trend');
const { makeSignal } = require('../createSignal');

function validTriple(c1, c2, c3) {
    return [c1, c2, c3].every((c) => isFiniteOhlcv(c) && c.closed === true) &&
        [c1, c2, c3].every((c) => candleMetrics(c).range > 0);
}

function detectTriples(candles, { thresholds, context, confirmation }) {
    const slice = takeLastClosed(candles, 3);
    if (!slice) return [];
    const [c1, c2, c3] = slice;
    if (!validTriple(c1, c2, c3)) return [];

    const m1 = candleMetrics(c1);
    const m2 = candleMetrics(c2);
    const m3 = candleMetrics(c3);
    const signals = [];

    const push = (spec) => {
        const matched = contextMatches(spec.requiredTrend, context);
        signals.push(makeSignal({
            name: spec.name,
            direction: spec.direction,
            type: spec.type,
            candleCount: 3,
            candles: { c1, c2, c3 },
            geometry: { c1: m1, c2: m2, c3: m3 },
            context,
            contextMatched: matched,
            confirmation,
            patternQuality: spec.quality,
            thresholds,
            confirmed: true,
            confirmationNote: 'Third candle completes the formation.',
            explanation: explain([
                spec.note,
                matched
                    ? `Context ${context.trend} supports interpretation.`
                    : `Context ${context.trend} does not match required ${spec.requiredTrend}.`,
                confirmation?.explanation,
            ]),
        }));
    };

    // Three inside up = bullish harami + bullish confirmation beyond first open.
    if (m1.isBearish && m2.isBullish && m3.isBullish &&
        bodyContainsBody(c1, c2) &&
        c3.close > c1.open) {
        push({
            name: 'Three Inside Up',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.7,
            note: 'Bullish harami confirmed by third close above first open.',
        });
    }

    // Three inside down
    if (m1.isBullish && m2.isBearish && m3.isBearish &&
        bodyContainsBody(c1, c2) &&
        c3.close < c1.open) {
        push({
            name: 'Three Inside Down',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.7,
            note: 'Bearish harami confirmed by third close below first open.',
        });
    }

    // Three outside up = bullish engulfing + higher close confirmation.
    if (m1.isBearish && m2.isBullish && m3.isBullish &&
        bodyEngulfsBody(c2, c1) && rangeEngulfsRange(c2, c1) &&
        c3.close > c2.high) {
        push({
            name: 'Three Outside Up',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.75,
            note: 'Bullish engulfing confirmed by third close above second high.',
        });
    }

    // Three outside down
    if (m1.isBullish && m2.isBearish && m3.isBearish &&
        bodyEngulfsBody(c2, c1) && rangeEngulfsRange(c2, c1) &&
        c3.close < c2.low) {
        push({
            name: 'Three Outside Down',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.75,
            note: 'Bearish engulfing confirmed by third close below second low.',
        });
    }

    // Morning star / bullish doji star
    const middleSmall = m2.bodyToRange <= thresholds.starMaxMiddleBodyToRange ||
        isDoji(m2, thresholds);
    const gapOk = !thresholds.starRequireGap ||
        gapDirection(c1, c2) === 'down' || c2.high < c1.close;
    if (m1.isBearish && middleSmall && m3.isBullish && gapOk &&
        (c3.close - c1.close) >=
            thresholds.starMinThirdRecoveryOfFirstBody * m1.body) {
        push({
            name: isDoji(m2, thresholds) ? 'Bullish Doji Star' : 'Morning Star',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: isDoji(m2, thresholds) ? 0.8 : 0.72,
            note: 'Bearish day, small/gapped middle, strong bullish recovery.',
        });
    }

    // Evening star / bearish doji star
    const gapUpOk = !thresholds.starRequireGap ||
        gapDirection(c1, c2) === 'up' || c2.low > c1.close;
    if (m1.isBullish && middleSmall && m3.isBearish && gapUpOk &&
        (c1.close - c3.close) >=
            thresholds.starMinThirdRecoveryOfFirstBody * m1.body) {
        push({
            name: isDoji(m2, thresholds) ? 'Bearish Doji Star' : 'Evening Star',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: isDoji(m2, thresholds) ? 0.8 : 0.72,
            note: 'Bullish day, small/gapped middle, strong bearish reversal day.',
        });
    }

    // Abandoned baby — rare; gaps on both sides of middle day.
    if (m1.isBearish && m3.isBullish &&
        c2.high < c1.low && c2.high < c3.low) {
        push({
            name: 'Bullish Abandoned Baby',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.85,
            note: 'Middle day gapped away from both neighbors (island).',
        });
    }
    if (m1.isBullish && m3.isBearish &&
        c2.low > c1.high && c2.low > c3.high) {
        push({
            name: 'Bearish Abandoned Baby',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.85,
            note: 'Middle day gapped away from both neighbors (island).',
        });
    }

    // Three white soldiers — progressive higher OHLC in downtrend context.
    if (m1.isBullish && m2.isBullish && m3.isBullish &&
        m1.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        m2.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        m3.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        c2.open > c1.open && c2.high > c1.high &&
        c2.low > c1.low && c2.close > c1.close &&
        c3.open > c2.open && c3.high > c2.high &&
        c3.low > c2.low && c3.close > c2.close) {
        push({
            name: 'Three White Soldiers',
            direction: 'bullish',
            type: 'reversal',
            requiredTrend: 'downtrend',
            quality: 0.75,
            note: 'Three progressive bullish candles with rising OHLC.',
        });
    }

    // Three black crows
    if (m1.isBearish && m2.isBearish && m3.isBearish &&
        m1.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        m2.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        m3.bodyToRange >= thresholds.soldiersMinBodyPercent &&
        c2.open < c1.open && c2.high < c1.high &&
        c2.low < c1.low && c2.close < c1.close &&
        c3.open < c2.open && c3.high < c2.high &&
        c3.low < c2.low && c3.close < c2.close) {
        push({
            name: 'Three Black Crows',
            direction: 'bearish',
            type: 'reversal',
            requiredTrend: 'uptrend',
            quality: 0.75,
            note: 'Three progressive bearish candles with falling OHLC.',
        });
    }

    // Upside / downside tasuki gap (continuation)
    if (m1.isBullish && m2.isBullish && m3.isBearish &&
        gapDirection(c1, c2) === 'up' &&
        c3.open < c2.close && c3.close > c1.high && c3.close < c2.low) {
        push({
            name: 'Upside Tasuki Gap',
            direction: 'bullish',
            type: 'continuation',
            requiredTrend: 'uptrend',
            quality: 0.55,
            note: 'Bullish gap continues; third day partially fills gap.',
        });
    }
    if (m1.isBearish && m2.isBearish && m3.isBullish &&
        gapDirection(c1, c2) === 'down' &&
        c3.open > c2.close && c3.close < c1.low && c3.close > c2.high) {
        push({
            name: 'Downside Tasuki Gap',
            direction: 'bearish',
            type: 'continuation',
            requiredTrend: 'downtrend',
            quality: 0.55,
            note: 'Bearish gap continues; third day partially fills gap.',
        });
    }

    return signals;
}

module.exports = { detectTriples };
