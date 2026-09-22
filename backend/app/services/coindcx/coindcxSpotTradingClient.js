const config = require('../../../config/config');
const { signedPost } = require('./coindcxAuth');

/**
 * Map futures instrument (B-BTC_USDT) → spot market (BTCINR).
 * Already-spot symbols (BTCINR) pass through unchanged.
 */
function futuresPairToSpotMarket(pair, quote) {
    const q = String(
        quote || config.AUTO_TRADE_SPOT_QUOTE || 'INR',
    ).toUpperCase();
    const p = String(pair || '').trim().toUpperCase();
    if (!p) return null;

    if (/^[A-Z0-9]+(INR|USDT|BTC)$/.test(p) && !p.startsWith('B-')) {
        return p;
    }

    const match = p.match(/^B-([A-Z0-9]+)_(USDT|INR|BTC)$/);
    if (!match) return null;
    return `${match[1]}${q}`;
}

/**
 * Spot place-order body per docs:
 * POST /exchange/v1/orders/create
 * Flat body — market, side, order_type, total_quantity, timestamp
 * price_per_unit only for limit orders.
 */
function buildSpotCreateBody(order) {
    const isMarket = (order.orderType || 'market_order') === 'market_order' ||
        order.orderType === 'market';

    const body = {
        side: order.side,
        order_type: isMarket ? 'market_order' : 'limit_order',
        market: order.market,
        total_quantity: Number(order.quantity),
        timestamp: Date.now(),
    };

    if (!isMarket) {
        body.price_per_unit = Number(order.pricePerUnit ?? order.price);
    }

    if (order.clientOrderId) {
        body.client_order_id = String(order.clientOrderId);
    }

    return body;
}

async function createSpotOrder(order) {
    const body = buildSpotCreateBody(order);
    return signedPost('/exchange/v1/orders/create', body);
}

module.exports = {
    futuresPairToSpotMarket,
    buildSpotCreateBody,
    createSpotOrder,
};
