const test = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateTradeOutcome,
    summarizeTrades,
} = require('../../app/services/candlestick/backtest');

const bullish = {
    direction: 'bullish',
    tradePlan: { entryPrice: 100, stopLoss: 95, takeProfit1: 107.5 },
};

test('backtest records target reached before stop as a win', () => {
    const result = evaluateTradeOutcome(bullish, [
        { high: 104, low: 98 },
        { high: 108, low: 97 },
    ]);
    assert.deepEqual(result, { outcome: 'win', bars: 2 });
});

test('backtest records stop reached before target as a loss', () => {
    const result = evaluateTradeOutcome(bullish, [
        { high: 103, low: 94 },
        { high: 110, low: 100 },
    ]);
    assert.deepEqual(result, { outcome: 'loss', bars: 1 });
});

test('backtest does not invent intrabar ordering when both levels trade', () => {
    const result = evaluateTradeOutcome(bullish, [{ high: 108, low: 94 }]);
    assert.deepEqual(result, { outcome: 'ambiguous', bars: 1 });
});

test('summary reports resolved and conservative accuracy separately', () => {
    const summary = summarizeTrades([
        { outcome: 'win' },
        { outcome: 'win' },
        { outcome: 'loss' },
        { outcome: 'ambiguous' },
        { outcome: 'unresolved' },
    ]);
    assert.equal(summary.accuracyPercent, 66.67);
    assert.equal(summary.conservativeAccuracyPercent, 50);
    assert.equal(summary.resolutionRatePercent, 80);
});
