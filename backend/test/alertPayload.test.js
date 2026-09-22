const test = require('node:test');
const assert = require('node:assert/strict');
const {
    pickSignalCandle,
    buildAlertPayload,
    toLatestSignalView,
} = require('../app/services/coindcx/alertPayload');

test('pickSignalCandle prefers confirmation, then c2, then c1', () => {
    const c1 = { openTime: 1 };
    const c2 = { openTime: 2 };
    const c3 = { openTime: 3 };
    assert.equal(pickSignalCandle({ confirmed: true, candles: { c1, c2, c3 } }), c3);
    assert.equal(pickSignalCandle({ confirmed: false, candles: { c1, c2 } }), c2);
    assert.equal(pickSignalCandle({ candles: { c1 } }), c1);
});

test('buildAlertPayload stores confidence and invalidation', () => {
    const payload = buildAlertPayload('B-BTC_USDT', 'BTC/USDT', {
        patternName: 'Bearish Engulfing',
        direction: 'bearish',
        type: 'reversal',
        confidence: 0.62,
        scores: { confidence: 0.62, patternQuality: 0.7 },
        context: { trend: 'uptrend', matched: true, strength: 0.8 },
        confirmation: { rsi: 72 },
        invalidation: { type: 'above_pattern_high', price: 110 },
        explanation: 'Test signal',
        confirmed: false,
        candles: {
            c1: { openTime: 1, closeTime: 2 },
            c2: { openTime: 3, closeTime: 4 },
        },
        metrics: { atr: 1.2 },
    }, '1d');
    assert.equal(payload.sPatternName, 'Bearish Engulfing');
    assert.equal(payload.sTimeframe, '1d');
    assert.equal(payload.sDirection, 'bearish');
    assert.equal(payload.nConfidence, 0.62);
    assert.equal(payload.oInvalidation.price, 110);
    assert.equal(payload.sAlertKey, 'B-BTC_USDT:1d:Bearish Engulfing:3');
});

test('toLatestSignalView exposes compact signal fields', () => {
    const view = toLatestSignalView({
        _id: 'abc',
        sPair: 'B-ETH_USDT',
        sSymbol: 'ETH/USDT',
        sTimeframe: '1m',
        sPatternName: 'Hammer',
        sDirection: 'bullish',
        sPatternType: 'reversal',
        nConfidence: 0.5,
        oScores: { confidence: 0.5 },
        oContext: { trend: 'downtrend', strength: 0.7, matched: true, sma: 1 },
        oInvalidation: { type: 'below_pattern_low', price: 90 },
        oTradePlan: {
            side: 'long',
            entryPrice: 100,
            stopLoss: 90,
            takeProfit1: 115,
            takeProfit2: 125,
            takeProfit3: 140,
            riskReward: { tp1R: 1.5, tp2R: 2.5, tp3R: 4 },
            stopDistancePct: 10,
            risk: { suggestedLeverage: 4, riskUsd: 5 },
        },
        bIsConfirmed: false,
        eEmailStatus: 'Sent',
        dSignalCandleOpenTime: new Date(0),
        dSignalCandleCloseTime: new Date(1),
        dCreatedAt: new Date(2),
        sExplanation: 'ok',
    });
    assert.equal(view.sId, 'abc');
    assert.equal(view.nConfidence, 0.5);
    assert.equal(view.oInvalidation.price, 90);
    assert.equal(view.oContext.trend, 'downtrend');
    assert.equal(view.oContext.sma, undefined);
    assert.equal(view.oTradePlan.stopLoss, 90);
    assert.equal(view.oTradePlan.risk.suggestedLeverage, 4);
});
