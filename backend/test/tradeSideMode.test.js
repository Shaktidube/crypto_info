const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveTradeSideMode,
    signalTradeSide,
    allowsTradeSide,
} = require('../app/services/candlestick/tradeSideMode');
const { analyzeCandles } = require('../app/services/candlestick');

function candle(open, high, low, close, volume, openTime, closed = true) {
    return {
        open, high, low, close, volume,
        openTime, closeTime: openTime + 59999, closed,
    };
}

function trendSeries(direction, count, startPrice = 100) {
    const candles = [];
    let price = startPrice;
    for (let i = 0; i < count; i += 1) {
        const open = price;
        const close = direction === 'up' ? price + 1 : price - 1;
        candles.push(candle(
            open,
            Math.max(open, close) + 0.2,
            Math.min(open, close) - 0.2,
            close,
            1000,
            i * 60000,
        ));
        price = close;
    }
    return candles;
}

test('resolveTradeSideMode accepts long/short/both aliases', () => {
    assert.equal(resolveTradeSideMode(''), 'both');
    assert.equal(resolveTradeSideMode('both'), 'both');
    assert.equal(resolveTradeSideMode('LONG'), 'long');
    assert.equal(resolveTradeSideMode('buy'), 'long');
    assert.equal(resolveTradeSideMode('short'), 'short');
    assert.equal(resolveTradeSideMode('bearish'), 'short');
});

test('allowsTradeSide filters correctly', () => {
    assert.equal(allowsTradeSide('long', 'long'), true);
    assert.equal(allowsTradeSide('long', 'short'), false);
    assert.equal(allowsTradeSide('short', 'short'), true);
    assert.equal(allowsTradeSide('both', 'short'), true);
    assert.equal(signalTradeSide({ direction: 'bullish' }), 'long');
    assert.equal(signalTradeSide({ direction: 'bearish' }), 'short');
});

test('analyzeCandles respects tradeSideMode=long', () => {
    const base = trendSeries('down', 25);
    const setup = candle(90, 91, 85, 86, 1200, 25 * 60000);
    const signal = candle(85.5, 92, 84, 91.5, 1500, 26 * 60000);
    const candles = [...base, setup, signal];

    const longs = analyzeCandles(candles, {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
        tradeSideMode: 'long',
    }).signals;
    assert.ok(longs.some((s) => s.patternName === 'Bullish Engulfing'));

    const blocked = analyzeCandles(candles, {
        enabledPatterns: ['Bullish Engulfing'],
        requireContextMatch: false,
        tradeSideMode: 'short',
    }).signals;
    assert.equal(blocked.length, 0);
});
