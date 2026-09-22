const config = require('../../../config/config');
const { signedPost, signBody } = require('./coindcxAuth');

/**
 * CoinDCX futures trading.
 * Docs: https://docs.coindcx.com/?javascript#create-order
 * POST /exchange/v1/derivatives/futures/orders/create
 *
 * NOTE: do not include time_in_force for market orders; price null for market.
 */
function buildFuturesCreateBody(order) {
    const isMarket = (order.orderType || 'market_order') === 'market_order' ||
        order.orderType === 'market';

    const orderType = isMarket
        ? 'market_order'
        : (order.orderType || 'limit_order');

    const nested = {
        side: order.side,
        pair: order.pair,
        order_type: orderType,
        price: isMarket ? null : String(order.price),
        stop_price: order.stopPrice != null && !isMarket
            ? String(order.stopPrice)
            : null,
        total_quantity: Number(order.quantity),
        leverage: Number(order.leverage || 1),
        notification: order.notification || 'no_notification',
        hidden: false,
        post_only: false,
        margin_currency_short_name: [
            order.marginCurrency || config.COINDCX_FUTURES_MARGIN_CURRENCY || 'INR',
        ],
    };

    if (!isMarket) {
        nested.time_in_force = order.timeInForce || 'good_till_cancel';
    }

    if (order.takeProfitPrice != null) {
        nested.take_profit_price = Number(order.takeProfitPrice);
    }
    if (order.stopLossPrice != null) {
        nested.stop_loss_price = Number(order.stopLossPrice);
    }

    return {
        timestamp: Date.now(),
        order: nested,
    };
}

async function createFuturesOrder(order) {
    const body = buildFuturesCreateBody(order);
    return signedPost(
        '/exchange/v1/derivatives/futures/orders/create',
        body,
    );
}

async function verifyCredentials() {
    const body = { timestamp: Date.now() };
    const result = await signedPost('/exchange/v1/users/info', body);
    return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        message: result.errorMessage || 'ok',
        data: result.data,
    };
}

module.exports = {
    createFuturesOrder,
    buildFuturesCreateBody,
    verifyCredentials,
    signBody,
    signedPost,
};
