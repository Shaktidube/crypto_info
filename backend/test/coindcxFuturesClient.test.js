const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRestCandle } = require('../app/services/coindcx/coindcxFuturesClient');
const {
    resolveTimeframe,
    closedBoundaryMs,
} = require('../app/services/coindcx/timeframes');

test('normalizes a CoinDCX futures REST candle for 1m', () => {
    const normalized = normalizeRestCandle({
        open: '100', high: '110', low: '99', close: '108',
        volume: '1234.5', quote_volume: '133326', time: 1700000000000,
    }, 60 * 1000);
    assert.deepEqual(normalized, {
        open: 100, high: 110, low: 99, close: 108,
        volume: 1234.5, quoteVolume: 133326,
        openTime: 1700000000000,
        closeTime: 1700000059999,
        closed: true,
    });
});

test('normalizes daily candle closeTime using 1d duration', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const openTime = 1700000000000;
    const normalized = normalizeRestCandle({
        open: '1', high: '2', low: '0.5', close: '1.5',
        volume: '10', time: openTime,
    }, dayMs);
    assert.equal(normalized.closeTime, openTime + dayMs - 1);
});

test('resolveTimeframe defaults map 1d and 4h correctly', () => {
    assert.equal(resolveTimeframe('1d').resolution, '1D');
    assert.equal(resolveTimeframe('4h').resolution, '240');
    assert.equal(resolveTimeframe('1m').resolution, '1');
});

test('closedBoundary excludes the forming candle', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 7, 26, 12, 30, 0);
    const boundary = closedBoundaryMs(now, dayMs);
    assert.equal(boundary, Date.UTC(2026, 7, 26, 0, 0, 0));
});
