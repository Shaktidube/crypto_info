const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBearishHarami } = require('../app/services/coindcx/candlePatternDetector');

function candle(open, high, low, close, volume, openTime) {
    return {
        open, high, low, close, volume,
        quoteVolume: volume * close,
        openTime,
        closeTime: openTime + 59999,
        closed: true,
    };
}

function matchingCandles() {
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
        candles.push(candle(100, 101, 99, 100.5, 1000, i * 60000));
    }
    candles.push(candle(100, 111, 99, 110, 1500, 20 * 60000));
    candles.push(candle(108, 109, 103, 105, 900, 21 * 60000));
    candles.push(candle(105, 106, 98, 100, 1700, 22 * 60000));
    return candles;
}

test('detects screenshot-style confirmed bearish harami', () => {
    const result = detectBearishHarami(matchingCandles());
    assert.equal(result.patternName, 'Bearish Harami');
    assert.equal(result.confirmed, true);
    assert.equal(result.candles.c2.volume, 900);
    assert.equal(result.metrics.volumeMultiplier, 1.5);
});

test('rejects inner candle outside the impulse body', () => {
    const candles = matchingCandles();
    candles.at(-2).open = 115;
    candles.at(-2).high = 116;
    assert.equal(detectBearishHarami(candles), null);
});

test('rejects insufficient impulse volume', () => {
    const candles = matchingCandles();
    candles.at(-3).volume = 1000;
    assert.equal(detectBearishHarami(candles), null);
});

test('rejects a forming confirmation candle', () => {
    const candles = matchingCandles();
    candles.at(-1).closed = false;
    assert.equal(detectBearishHarami(candles), null);
});

test('rejects zero-range and missing-volume candles', () => {
    const zeroRange = matchingCandles();
    Object.assign(
        zeroRange.at(-2),
        { open: 105, high: 105, low: 105, close: 105 },
    );
    assert.equal(detectBearishHarami(zeroRange), null);

    const missingVolume = matchingCandles();
    missingVolume.at(-2).volume = undefined;
    assert.equal(detectBearishHarami(missingVolume), null);
});

test('supports detection without confirmation', () => {
    const candles = matchingCandles().slice(0, -1);
    const result = detectBearishHarami(candles, { requireConfirmation: false });
    assert.equal(result.confirmed, false);
});
