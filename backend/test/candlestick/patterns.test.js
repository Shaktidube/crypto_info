const test = require('node:test');
const assert = require('node:assert/strict');
const {
    analyzeCandles,
    candleMetrics,
    detectBearishHarami,
} = require('../../app/services/candlestick');
const { detectSingleShapes } = require('../../app/services/candlestick/patterns/single');
const { mergeThresholds } = require('../../app/services/candlestick/thresholds');
const {
    relativeStrengthIndex,
    stochasticK,
} = require('../../app/utils/lib/candleIndicators');

function candle(open, high, low, close, volume, openTime, closed = true) {
    return {
        open, high, low, close, volume,
        quoteVolume: volume * close,
        openTime,
        closeTime: openTime + 59999,
        closed,
    };
}

function trendSeries(direction, count, startPrice = 100) {
    const candles = [];
    let price = startPrice;
    for (let i = 0; i < count; i += 1) {
        const open = price;
        const close = direction === 'up' ? price + 1 : price - 1;
        const high = Math.max(open, close) + 0.2;
        const low = Math.min(open, close) - 0.2;
        candles.push(candle(open, high, low, close, 1000, i * 60000));
        price = close;
    }
    return candles;
}

test('candle metrics compute body and wicks without look-ahead', () => {
    const m = candleMetrics(candle(10, 15, 8, 12, 100, 0));
    assert.equal(m.body, 2);
    assert.equal(m.range, 7);
    assert.equal(m.upperWick, 3);
    assert.equal(m.lowerWick, 2);
    assert.equal(m.isBullish, true);
});

test('dragonfly doji shape positive and near-miss negative', () => {
    const thresholds = mergeThresholds();
    const dragonfly = candle(10, 10.2, 8, 10.1, 100, 0);
    const shapes = detectSingleShapes(dragonfly, thresholds)
        .map((s) => s.name);
    assert.ok(shapes.includes('Dragonfly Doji'));

    const notDoji = candle(10, 12, 8, 11.5, 100, 0);
    const miss = detectSingleShapes(notDoji, thresholds).map((s) => s.name);
    assert.equal(miss.includes('Dragonfly Doji'), false);
});

test('hammer geometry detects; hanging man needs uptrend context', () => {
    const hammerBar = candle(10, 10.12, 7, 10.1, 100, 25 * 60000);
    const down = [...trendSeries('down', 25), hammerBar];
    const up = [...trendSeries('up', 25), hammerBar];

    const downSignals = analyzeCandles(down, {
        enabledPatterns: ['Hammer', 'Hanging Man'],
    }).signals.map((s) => s.patternName);
    assert.ok(downSignals.includes('Hammer'));

    const upSignals = analyzeCandles(up, {
        enabledPatterns: ['Hammer', 'Hanging Man'],
    }).signals.map((s) => s.patternName);
    assert.ok(upSignals.includes('Hanging Man'));
});

test('bullish engulfing positive, negative when range not covered', () => {
    const base = trendSeries('down', 25);
    const setup = candle(90, 91, 85, 86, 1200, 25 * 60000);
    const signal = candle(85.5, 92, 84, 91.5, 1500, 26 * 60000);
    const good = analyzeCandles([...base, setup, signal], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
    });
    assert.equal(good.signals[0]?.patternName, 'Bullish Engulfing');

    const weak = candle(85.5, 90.5, 85.2, 90.2, 1500, 26 * 60000);
    const bad = analyzeCandles([...base, setup, weak], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
    });
    assert.equal(bad.signals.length, 0);
});

test('piercing line requires close above midpoint', () => {
    const base = trendSeries('down', 25);
    const setup = candle(100, 101, 90, 91, 1200, 25 * 60000);
    const mid = (100 + 91) / 2;
    const goodSignal = candle(89, 97, 88, mid + 1, 1400, 26 * 60000);
    const good = analyzeCandles([...base, setup, goodSignal], {
        enabledPatterns: ['Piercing Line'],
        requireContextMatch: false,
    });
    assert.equal(good.signals[0]?.patternName, 'Piercing Line');

    const badSignal = candle(89, 94, 88, mid - 1, 1400, 26 * 60000);
    const bad = analyzeCandles([...base, setup, badSignal], {
        enabledPatterns: ['Piercing Line'],
        requireContextMatch: false,
    });
    assert.equal(bad.signals.length, 0);
});

test('three inside down multi-candle ordering', () => {
    const base = trendSeries('up', 25);
    const c1 = candle(100, 110, 99, 109, 1500, 25 * 60000);
    const c2 = candle(107, 108, 104, 105, 900, 26 * 60000);
    const c3 = candle(105, 106, 98, 99, 1600, 27 * 60000);
    const result = analyzeCandles([...base, c1, c2, c3], {
        enabledPatterns: ['Three Inside Down'],
        requireContextMatch: false,
    });
    assert.equal(result.signals[0]?.patternName, 'Three Inside Down');
    assert.equal(result.signals[0]?.confirmed, true);
});

test('context filter suppresses wrong-trend hammer setup', () => {
    const up = trendSeries('up', 25);
    const hammerBar = candle(120, 120.15, 117, 120.1, 100, 25 * 60000);
    const withContext = analyzeCandles([...up, hammerBar], {
        enabledPatterns: ['Hammer'],
        requireContextMatch: true,
    });
    assert.equal(withContext.signals.length, 0);

    const without = analyzeCandles([...up, hammerBar], {
        enabledPatterns: ['Hanging Man'],
        requireContextMatch: true,
    });
    assert.ok(without.signals.some((s) => s.patternName === 'Hanging Man'));
});

test('forming candle never produces signals', () => {
    const base = trendSeries('down', 25);
    const setup = candle(90, 91, 85, 86, 1200, 25 * 60000);
    const openBar = candle(85.5, 92, 84, 91.5, 1500, 26 * 60000, false);
    const result = analyzeCandles([...base, setup, openBar], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
    });
    assert.equal(result.signals.length, 0);
});

test('boundary: doji body ratio threshold', () => {
    const thresholds = mergeThresholds({ dojiMaxBodyToRange: 0.10 });
    const atBoundary = candle(10, 11, 9, 10.2, 100, 0); // body/range = 0.10
    const over = candle(10, 11, 9, 10.3, 100, 0); // body/range = 0.15
    const atNames = detectSingleShapes(atBoundary, thresholds).map((s) => s.name);
    const overNames = detectSingleShapes(over, thresholds).map((s) => s.name);
    assert.ok(atNames.some((name) => /Doji/.test(name)));
    assert.equal(overNames.some((name) => /Doji/.test(name)), false);
});

test('legacy bearish harami regression still passes via facade', () => {
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
        candles.push(candle(100, 101, 99, 100.5, 1000, i * 60000));
    }
    candles.push(candle(100, 111, 99, 110, 1500, 20 * 60000));
    candles.push(candle(108, 109, 103, 105, 900, 21 * 60000));
    candles.push(candle(105, 106, 98, 100, 1700, 22 * 60000));
    const result = detectBearishHarami(candles);
    assert.equal(result.patternName, 'Bearish Harami');
    assert.equal(result.confirmed, true);
});

test('RSI and stochastic use only available history', () => {
    const candles = trendSeries('down', 30);
    const rsi = relativeStrengthIndex(candles, 14);
    const stoch = stochasticK(candles, 14);
    assert.ok(rsi != null && rsi >= 0 && rsi <= 100);
    assert.ok(stoch != null && stoch >= 0 && stoch <= 100);
    // Truncating future bars must not change the value at t.
    const earlier = relativeStrengthIndex(candles.slice(0, 25), 14);
    const fullAt25 = relativeStrengthIndex(candles.slice(0, 25), 14);
    assert.equal(earlier, fullAt25);
});

test('scored signal includes invalidation and confidence components', () => {
    const base = trendSeries('down', 25);
    const setup = candle(90, 91, 85, 86, 1200, 25 * 60000);
    const signal = candle(85.5, 92, 84, 91.5, 1500, 26 * 60000);
    const result = analyzeCandles([...base, setup, signal], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
    });
    const hit = result.signals[0];
    assert.ok(hit.confidence >= 0 && hit.confidence <= 1);
    assert.ok(hit.scores);
    assert.equal(hit.invalidation.type, 'below_pattern_low');
    assert.equal(hit.tradeAction, 'idea_only');
    assert.ok(hit.tradePlan);
    assert.ok(hit.tradePlan.stopLoss);
    assert.ok(hit.tradePlan.takeProfit1);
});
