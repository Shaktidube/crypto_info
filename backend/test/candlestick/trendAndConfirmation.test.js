const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCandles } = require('../../app/services/candlestick');
const {
    detectTrend,
    buildContext,
} = require('../../app/services/candlestick/context/trend');
const { buildConfirmation } = require(
    '../../app/services/candlestick/confirmation/engine'
);
const { mergeThresholds } = require(
    '../../app/services/candlestick/thresholds'
);

function candle(open, high, low, close, volume, openTime) {
    return {
        open,
        high,
        low,
        close,
        volume,
        quoteVolume: volume * close,
        openTime,
        closeTime: openTime + 59999,
        closed: true,
    };
}

function trendSeries(direction, count, startPrice = 100) {
    const rows = [];
    let price = startPrice;
    for (let i = 0; i < count; i += 1) {
        const open = price;
        const close = direction === 'up' ? price + 1 : price - 1;
        rows.push(candle(
            open,
            Math.max(open, close) + 0.2,
            Math.min(open, close) - 0.2,
            close,
            1000,
            i * 60000,
        ));
        price = close;
    }
    return rows;
}

test('multi-factor trend identifies directional and choppy history', () => {
    const thresholds = mergeThresholds();
    const down = detectTrend(trendSeries('down', 30), thresholds);
    assert.equal(down.trend, 'downtrend');
    assert.ok(down.evidence.down >= down.evidence.required);
    assert.equal(down.structure, 'lower');

    const choppy = [];
    for (let i = 0; i < 30; i += 1) {
        const open = 100 + (i % 2 === 0 ? -1 : 1);
        const close = 100 + (i % 2 === 0 ? 1 : -1);
        choppy.push(candle(open, 102, 98, close, 1000, i * 60000));
    }
    const sideways = detectTrend(choppy, thresholds);
    assert.equal(sideways.trend, 'sideways');
    assert.equal(sideways.strength, 0);
});

test('pattern candles cannot alter the measured prior trend', () => {
    const thresholds = mergeThresholds();
    const prior = trendSeries('down', 30);
    const bullishShock = candle(70, 150, 69, 145, 3000, 30 * 60000);
    const bearishShock = candle(70, 71, 5, 6, 3000, 30 * 60000);
    const bullishContext = buildContext(
        [...prior, bullishShock], 1, thresholds,
    );
    const bearishContext = buildContext(
        [...prior, bearishShock], 1, thresholds,
    );
    assert.equal(bullishContext.trend, 'downtrend');
    assert.equal(bearishContext.trend, 'downtrend');
    assert.equal(bullishContext.slowSma, bearishContext.slowSma);
    assert.equal(
        bullishContext.normalizedMoveAtr,
        bearishContext.normalizedMoveAtr,
    );
});

test('two-candle signal waits for closed directional confirmation', () => {
    const base = trendSeries('down', 30);
    const c1 = candle(72, 73, 67, 68, 1200, 30 * 60000);
    const c2 = candle(67.5, 74, 66.5, 73.5, 1600, 31 * 60000);
    const c3 = candle(73, 76, 72.5, 75, 1800, 32 * 60000);
    const beforeConfirmation = analyzeCandles([...base, c1, c2], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: true,
        requirePriceConfirmation: true,
    });
    assert.equal(beforeConfirmation.signals.length, 0);

    const afterConfirmation = analyzeCandles([...base, c1, c2, c3], {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: true,
        requirePriceConfirmation: true,
    });
    const signal = afterConfirmation.signals[0];
    assert.equal(signal?.patternName, 'Bullish Engulfing');
    assert.equal(signal?.confirmed, true);
    assert.equal(signal?.candles.c3, c3);
    assert.match(signal?.confirmation.note, /confirmed beyond/);
    assert.equal(signal?.tradePlan.entryPrice, c3.close);
});

test('volume confirmation is scored separately from oscillators', () => {
    const thresholds = mergeThresholds();
    const candles = trendSeries('up', 30);
    candles.at(-1).volume = 2000;
    const confirmation = buildConfirmation(
        candles, 'bullish', thresholds,
    );
    assert.equal(confirmation.volumeSupports, true);
    assert.equal(confirmation.rsiSupports, false);
    assert.equal(confirmation.stochSupports, false);
    assert.equal(confirmation.strength, 0);
});
