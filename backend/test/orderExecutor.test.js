const test = require('node:test');
const assert = require('node:assert/strict');
const {
    quantityFromPlan,
    buildOrderRequest,
    futuresPairToSpotMarket,
} = require('../app/services/coindcx/orderExecutor');
const { signBody } = require('../app/services/coindcx/coindcxFuturesTradingClient');
const {
    buildSpotCreateBody,
    futuresPairToSpotMarket: mapSpot,
} = require('../app/services/coindcx/coindcxSpotTradingClient');
const { buildFuturesCreateBody } = require('../app/services/coindcx/coindcxFuturesTradingClient');

test('quantityFromPlan converts INR notional to coin size (futures)', () => {
    const qty = quantityFromPlan({
        entryPrice: 100000,
        risk: {
            currency: 'INR',
            positionNotional: 9000,
        },
    }, {
        pair: 'B-BTC_USDT',
        usdtInrRate: 90,
        quantityDecimals: 4,
        market: 'futures',
    });
    // notional USDT = 9000/90 = 100; qty = 100/100000 = 0.001
    assert.equal(qty, 0.001);
});

test('quantityFromPlan spot INR uses converted entry (same qty)', () => {
    const qty = quantityFromPlan({
        entryPrice: 100000,
        risk: {
            currency: 'INR',
            positionNotional: 9000,
        },
    }, {
        pair: 'B-BTC_USDT',
        usdtInrRate: 90,
        quantityDecimals: 4,
        market: 'spot',
        spotQuote: 'INR',
    });
    // entryINR = 100000*90; qty = 9000 / 9e6 = 0.001
    assert.equal(qty, 0.001);
});

test('buildOrderRequest maps long/short to buy/sell with SL TP (futures)', () => {
    const built = buildOrderRequest('B-BTC_USDT', {
        tradePlan: {
            side: 'long',
            entryPrice: 100,
            stopLoss: 95,
            takeProfit1: 107.5,
            risk: {
                currency: 'INR',
                positionNotional: 900,
                suggestedLeverage: 3,
            },
        },
    }, {
        marginCurrency: 'INR',
        usdtInrRate: 90,
        quantityDecimals: 4,
        minQuantity: 0.0001,
        market: 'futures',
    });
    assert.equal(built.ok, true);
    assert.equal(built.market, 'futures');
    assert.equal(built.request.side, 'buy');
    assert.equal(built.request.pair, 'B-BTC_USDT');
    assert.equal(built.request.stopLossPrice, 95);
    assert.equal(built.request.takeProfitPrice, 107.5);
    assert.equal(built.request.leverage, 3);
});

test('buildOrderRequest spot maps B-BTC_USDT → BTCINR and has no leverage', () => {
    const built = buildOrderRequest('B-BTC_USDT', {
        tradePlan: {
            side: 'long',
            entryPrice: 100,
            stopLoss: 95,
            takeProfit1: 107.5,
            risk: {
                currency: 'INR',
                positionNotional: 900,
                suggestedLeverage: 3,
            },
        },
    }, {
        usdtInrRate: 90,
        quantityDecimals: 4,
        minQuantity: 0.0001,
        market: 'spot',
        spotQuote: 'INR',
    });
    assert.equal(built.ok, true);
    assert.equal(built.market, 'spot');
    assert.equal(built.request.side, 'buy');
    assert.equal(built.request.market, 'BTCINR');
    assert.equal(built.request.leverage, undefined);
    assert.equal(built.request.pair, undefined);
    assert.equal(built.planSummary.leverage, 1);
    assert.equal(built.planSummary.spotMarket, 'BTCINR');
});

test('buildOrderRequest rejects short in spot mode', () => {
    const built = buildOrderRequest('B-ETH_USDT', {
        tradePlan: {
            side: 'short',
            entryPrice: 2000,
            stopLoss: 2100,
            takeProfit1: 1800,
            risk: {
                currency: 'INR',
                positionNotional: 900,
            },
        },
    }, {
        market: 'spot',
        usdtInrRate: 90,
    });
    assert.equal(built.ok, false);
    assert.match(built.reason, /long\/buy only/i);
});

test('futuresPairToSpotMarket maps and passes through', () => {
    assert.equal(futuresPairToSpotMarket('B-BTC_USDT', 'INR'), 'BTCINR');
    assert.equal(mapSpot('B-ETH_USDT', 'USDT'), 'ETHUSDT');
    assert.equal(mapSpot('BTCINR', 'INR'), 'BTCINR');
    assert.equal(mapSpot('not-a-pair', 'INR'), null);
});

test('buildSpotCreateBody is flat market_order without price', () => {
    const body = buildSpotCreateBody({
        side: 'buy',
        market: 'BTCINR',
        orderType: 'market_order',
        quantity: 0.001,
    });
    assert.equal(body.side, 'buy');
    assert.equal(body.market, 'BTCINR');
    assert.equal(body.order_type, 'market_order');
    assert.equal(body.total_quantity, 0.001);
    assert.equal(body.price_per_unit, undefined);
    assert.equal(body.order, undefined);
    assert.equal(typeof body.timestamp, 'number');
});

test('buildFuturesCreateBody omits time_in_force for market orders', () => {
    const body = buildFuturesCreateBody({
        side: 'buy',
        pair: 'B-ETH_USDT',
        orderType: 'market_order',
        quantity: 0.01,
        leverage: 2,
        marginCurrency: 'INR',
        takeProfitPrice: 3500,
        stopLossPrice: 3000,
    });
    assert.equal(body.order.order_type, 'market_order');
    assert.equal(body.order.price, null);
    assert.equal(body.order.time_in_force, undefined);
});

test('signBody is deterministic HMAC hex', () => {
    const { signature } = signBody({ a: 1 }, 'secret');
    assert.match(signature, /^[a-f0-9]{64}$/);
});
