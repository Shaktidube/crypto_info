const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTradePlan,
    isHighQualitySignal,
    attachTradePlan,
} = require('../app/services/candlestick/risk/tradePlan');

function baseSignal(overrides = {}) {
    return {
        patternName: 'Bearish Engulfing',
        direction: 'bearish',
        type: 'reversal',
        candleCount: 2,
        confidence: 0.62,
        context: { matched: true, strength: 0.7, trend: 'uptrend' },
        confirmation: { strength: 0.66, atr: 2 },
        invalidation: { type: 'above_pattern_high', price: 110 },
        candles: {
            c1: { open: 100, high: 105, low: 99, close: 104, openTime: 1 },
            c2: {
                open: 106, high: 108, low: 98, close: 100,
                openTime: 2, closeTime: 3,
            },
        },
        metrics: { atr: 2 },
        ...overrides,
    };
}

test('trade plan builds SL TP and leverage for short on INR account', () => {
    const plan = buildTradePlan(baseSignal(), {
        accountBalance: 2000,
        accountCurrency: 'INR',
        riskPercent: 1,
        maxLeverageCap: 5,
        leverageSafetyFactor: 0.35,
        maxMarginFraction: 0.40,
        atrBufferMult: 0.1,
    });
    assert.equal(plan.side, 'short');
    assert.equal(plan.entryPrice, 100);
    assert.ok(plan.stopLoss > plan.entryPrice);
    assert.ok(plan.takeProfit1 < plan.entryPrice);
    assert.ok(plan.takeProfit2 < plan.takeProfit1);
    assert.equal(plan.risk.currency, 'INR');
    assert.equal(plan.risk.accountBalance, 2000);
    assert.ok(plan.risk.suggestedLeverage >= 1);
    assert.ok(plan.risk.suggestedLeverage <= 5);
    assert.ok(plan.risk.marginRequired <= 2000 * 0.40 + 0.01);
    assert.ok(plan.risk.positionNotional > 0);
});

test('high quality filter rejects average / weak setups', () => {
    assert.equal(isHighQualitySignal(baseSignal()), true);
    assert.equal(isHighQualitySignal(baseSignal({ confidence: 0.4 })), false);
    assert.equal(isHighQualitySignal(baseSignal({
        context: { matched: false, strength: 0.2, trend: 'sideways' },
    })), false);
    assert.equal(isHighQualitySignal(baseSignal({
        patternName: 'Hammer',
        candleCount: 1,
    })), false);
});

test('attachTradePlan marks idea_only', () => {
    const out = attachTradePlan(baseSignal(), {
        accountBalance: 2000,
        accountCurrency: 'INR',
    });
    assert.equal(out.tradeAction, 'idea_only');
    assert.ok(out.tradePlan.stopLoss);
    assert.equal(out.tradePlan.risk.currency, 'INR');
});
