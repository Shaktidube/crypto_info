const config = require('../../../config/config');
const futuresClient = require('./coindcxFuturesTradingClient');
const spotClient = require('./coindcxSpotTradingClient');

function tradeMarketMode(options = {}) {
    return String(
        options.market || config.AUTO_TRADE_MARKET || 'futures',
    ).toLowerCase();
}

function spotQuote(options = {}) {
    return String(
        options.spotQuote || config.AUTO_TRADE_SPOT_QUOTE || 'INR',
    ).toUpperCase();
}

/**
 * Convert trade-plan notional into exchange quantity.
 *
 * Futures INR account + USDT-priced pair: convert notional INR→USDT.
 * Spot INR market + USDT-priced futures signal: convert entry USDT→INR,
 * keep notional in INR (same economic qty either way).
 */
function quantityFromPlan(plan, options = {}) {
    const entry = Number(plan.entryPrice);
    const notional = Number(plan.risk?.positionNotional);
    if (!(entry > 0) || !(notional > 0)) return null;

    const currency = String(
        plan.risk?.currency || options.accountCurrency || 'INR',
    ).toUpperCase();
    const pair = String(options.pair || '');
    const usdtPriced = /_USDT$/i.test(pair) || options.usdtPriced === true;
    const mode = tradeMarketMode(options);
    const quote = spotQuote(options);
    const rate = Number(options.usdtInrRate || config.TRADE_USDT_INR_RATE);

    let entryInQuote = entry;
    let notionalInQuote = notional;

    if (mode === 'spot' && quote === 'INR' && currency === 'INR' && usdtPriced) {
        if (!(rate > 0)) return null;
        entryInQuote = entry * rate;
        notionalInQuote = notional;
    } else if (currency === 'INR' && usdtPriced) {
        if (!(rate > 0)) return null;
        notionalInQuote = notional / rate;
    }

    const rawQty = notionalInQuote / entryInQuote;
    const decimals = Number(options.quantityDecimals ??
        config.AUTO_TRADE_QUANTITY_DECIMALS ?? 4);
    const factor = 10 ** decimals;
    const quantity = Math.floor(rawQty * factor) / factor;
    if (!(quantity > 0)) return null;
    return quantity;
}

function buildOrderRequest(pair, signal, options = {}) {
    const plan = signal?.tradePlan;
    if (!plan) {
        return { ok: false, reason: 'Missing trade plan on signal' };
    }

    const mode = tradeMarketMode(options);
    if (mode === 'spot' && plan.side === 'short') {
        return {
            ok: false,
            reason: 'Spot mode supports long/buy only — short skipped',
        };
    }

    const quantity = quantityFromPlan(plan, {
        ...options,
        pair,
        market: mode,
    });
    if (!quantity) {
        return {
            ok: false,
            reason: 'Could not derive a valid order quantity from the plan',
        };
    }

    const minQty = Number(options.minQuantity || config.AUTO_TRADE_MIN_QUANTITY || 0);
    if (quantity < minQty) {
        return {
            ok: false,
            reason: `Quantity ${quantity} below AUTO_TRADE_MIN_QUANTITY ${minQty}`,
            quantity,
        };
    }

    const side = plan.side === 'long' ? 'buy' : 'sell';

    if (mode === 'spot') {
        const market = spotClient.futuresPairToSpotMarket(
            pair,
            spotQuote(options),
        );
        if (!market) {
            return {
                ok: false,
                reason: `Cannot map futures pair ${pair} to a spot market`,
            };
        }
        return {
            ok: true,
            market: 'spot',
            request: {
                side,
                market,
                orderType: 'market_order',
                quantity,
                // SL/TP kept for alert context only (not sent on spot create v1)
                takeProfitPrice: plan.takeProfit1,
                stopLossPrice: plan.stopLoss,
            },
            planSummary: {
                side: plan.side,
                entry: plan.entryPrice,
                stopLoss: plan.stopLoss,
                takeProfit1: plan.takeProfit1,
                leverage: 1,
                quantity,
                riskAmount: plan.risk?.riskAmount,
                currency: plan.risk?.currency,
                spotMarket: market,
            },
        };
    }

    const leverage = Math.max(
        1,
        Math.min(
            Number(plan.risk?.suggestedLeverage || 1),
            Number(config.TRADE_MAX_LEVERAGE_CAP || 5),
        ),
    );

    return {
        ok: true,
        market: 'futures',
        request: {
            side,
            pair,
            orderType: 'market_order',
            quantity,
            leverage,
            marginCurrency: options.marginCurrency ||
                config.COINDCX_FUTURES_MARGIN_CURRENCY,
            takeProfitPrice: plan.takeProfit1,
            stopLossPrice: plan.stopLoss,
        },
        planSummary: {
            side: plan.side,
            entry: plan.entryPrice,
            stopLoss: plan.stopLoss,
            takeProfit1: plan.takeProfit1,
            leverage,
            quantity,
            riskAmount: plan.risk?.riskAmount,
            currency: plan.risk?.currency,
        },
    };
}

/**
 * Execute (or dry-run) spot or futures order from an analyzed signal.
 */
async function executeSignalOrder(pair, signal, options = {}) {
    const enabled = options.enabled ?? config.AUTO_TRADE_ENABLED;
    const dryRun = options.dryRun ?? config.AUTO_TRADE_DRY_RUN;
    const mode = tradeMarketMode(options);

    if (!enabled) {
        return {
            status: 'skipped',
            reason: 'AUTO_TRADE_ENABLED is false',
            market: mode,
        };
    }

    const built = buildOrderRequest(pair, signal, options);
    if (!built.ok) {
        return {
            status: 'rejected',
            reason: built.reason,
            quantity: built.quantity,
            market: mode,
        };
    }

    if (dryRun) {
        return {
            status: 'dry_run',
            reason: 'AUTO_TRADE_DRY_RUN is true — order not sent',
            market: built.market,
            request: built.request,
            planSummary: built.planSummary,
        };
    }

    const response = built.market === 'spot'
        ? await spotClient.createSpotOrder(built.request)
        : await futuresClient.createFuturesOrder(built.request);

    const ok = response.status >= 200 && response.status < 300;
    return {
        status: ok ? 'submitted' : 'failed',
        httpStatus: response.status,
        market: built.market,
        reason: ok
            ? ''
            : (response.errorMessage || `HTTP ${response.status}`),
        request: built.request,
        planSummary: built.planSummary,
        exchange: response.data,
    };
}

module.exports = {
    quantityFromPlan,
    buildOrderRequest,
    executeSignalOrder,
    tradeMarketMode,
    futuresPairToSpotMarket: spotClient.futuresPairToSpotMarket,
};
