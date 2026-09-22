/**
 * Analytical trade plan from candle structure.
 * Does NOT place orders. Leverage is risk framing only.
 *
 * Sized for the configured account balance/currency (e.g. INR 2000).
 * SL: pattern invalidation + ATR buffer.
 * TP: reward multiples of risk (R).
 * Leverage: capped so approx liquidation stays beyond the stop,
 * and margin used stays within a fraction of the account.
 */
function buildTradePlan(signal, options = {}) {
    const direction = signal?.direction;
    if (direction !== 'bullish' && direction !== 'bearish') return null;

    const candle = pickEntryCandle(signal);
    if (!candle || !Number.isFinite(candle.close)) return null;

    const entry = candle.close;
    const rawStop = signal.invalidation?.price;
    if (!Number.isFinite(rawStop)) return null;

    const currency = String(options.accountCurrency || 'INR').toUpperCase();
    const atr = signal.metrics?.atr ?? signal.confirmation?.atr ?? null;
    const atrBufferMult = num(options.atrBufferMult, 0.1);
    const buffer = atr != null ? atr * atrBufferMult : Math.abs(entry) * 0.0005;

    let stopLoss = direction === 'bullish'
        ? rawStop - buffer
        : rawStop + buffer;

    if (direction === 'bullish' && stopLoss >= entry) {
        stopLoss = entry - Math.max(buffer, Math.abs(entry) * 0.001);
    }
    if (direction === 'bearish' && stopLoss <= entry) {
        stopLoss = entry + Math.max(buffer, Math.abs(entry) * 0.001);
    }

    const riskPerUnit = Math.abs(entry - stopLoss);
    if (!(riskPerUnit > 0)) return null;

    const r1 = num(options.tp1R, 1.5);
    const r2 = num(options.tp2R, 2.5);
    const r3 = num(options.tp3R, 4.0);
    const sign = direction === 'bullish' ? 1 : -1;

    const takeProfit1 = entry + sign * riskPerUnit * r1;
    const takeProfit2 = entry + sign * riskPerUnit * r2;
    const takeProfit3 = entry + sign * riskPerUnit * r3;

    const stopDistancePct = riskPerUnit / entry;
    const accountBalance = num(
        options.accountBalance,
        num(options.accountBalanceUsd, 2000),
    );
    const riskPercent = num(options.riskPercent, 1);
    let riskAmount = accountBalance * (riskPercent / 100);
    let positionNotional = riskAmount / stopDistancePct;

    // Approx isolated max leverage before liq sits near the stop.
    const theoreticalMaxLeverage = entry / riskPerUnit;
    const leverageSafety = num(options.leverageSafetyFactor, 0.35);
    const configuredCap = num(options.maxLeverageCap, 5);
    let suggestedLeverage = clamp(
        Math.floor(theoreticalMaxLeverage * leverageSafety),
        1,
        configuredCap,
    );

    // Keep margin within a safe share of the small account.
    const maxMarginFraction = num(options.maxMarginFraction, 0.40);
    const maxMargin = accountBalance * maxMarginFraction;
    let marginRequired = positionNotional / suggestedLeverage;

    if (marginRequired > maxMargin) {
        // Prefer lowering size first; then leverage if still too large.
        positionNotional = maxMargin * suggestedLeverage;
        riskAmount = positionNotional * stopDistancePct;
        marginRequired = maxMargin;
    }

    // If even 1x needs more margin than allowed, shrink to maxMargin at 1x.
    if (marginRequired > maxMargin) {
        suggestedLeverage = 1;
        positionNotional = maxMargin;
        marginRequired = maxMargin;
        riskAmount = positionNotional * stopDistancePct;
    }

    const rewardAtTp1 = riskAmount * r1;
    const rewardAtTp2 = riskAmount * r2;

    const riskBlock = {
        currency,
        accountBalance: round(accountBalance, 2),
        riskPercent,
        riskAmount: round(riskAmount, 2),
        positionNotional: round(positionNotional, 2),
        marginRequired: round(marginRequired, 2),
        suggestedLeverage,
        theoreticalMaxLeverage: round(theoreticalMaxLeverage, 2),
        maxMarginFraction,
        rewardAtTp1: round(rewardAtTp1, 2),
        rewardAtTp2: round(rewardAtTp2, 2),
        // Backward-compatible aliases used by older email/API clients.
        accountBalanceUsd: round(accountBalance, 2),
        riskUsd: round(riskAmount, 2),
        positionNotionalUsd: round(positionNotional, 2),
        marginRequiredUsd: round(marginRequired, 2),
        rewardAtTp1Usd: round(rewardAtTp1, 2),
        rewardAtTp2Usd: round(rewardAtTp2, 2),
    };

    return {
        side: direction === 'bullish' ? 'long' : 'short',
        entryPrice: round(entry),
        stopLoss: round(stopLoss),
        takeProfit1: round(takeProfit1),
        takeProfit2: round(takeProfit2),
        takeProfit3: round(takeProfit3),
        riskReward: { tp1R: r1, tp2R: r2, tp3R: r3 },
        stopDistancePct: round(stopDistancePct * 100, 4),
        risk: riskBlock,
        notes: [
            'Analytical plan only — no order is placed.',
            `Sized for ${currency} ${round(accountBalance, 2)} account.`,
            'Entry assumes acting after the signal candle closes.',
            'Leverage is capped for small-account survival (liq beyond SL).',
            'If exchange min-order size exceeds this plan, skip the trade.',
        ],
    };
}

function isHighQualitySignal(signal, options = {}) {
    if (!signal) return false;
    const minConfidence = num(options.minConfidence, 0.55);
    const minConfirm = num(options.minConfirmationStrength, 0.33);
    const requireContext = options.requireContextMatch !== false;
    const premiumOnly = options.premiumPatternsOnly !== false;
    const minCandles = num(options.minCandleCount, 2);

    if (!Number.isFinite(signal.confidence) ||
        signal.confidence < minConfidence) return false;
    if (requireContext && !signal.context?.matched) return false;
    if ((signal.confirmation?.strength || 0) < minConfirm) return false;
    if (signal.direction !== 'bullish' && signal.direction !== 'bearish') {
        return false;
    }

    const premium = new Set((options.premiumPatterns || DEFAULT_PREMIUM)
        .map((name) => name.toLowerCase()));
    if (premiumOnly && !premium.has(String(signal.patternName).toLowerCase())) {
        return false;
    }

    if ((signal.candleCount || 1) < minCandles &&
        !ALLOW_SINGLE.has(String(signal.patternName).toLowerCase())) {
        return false;
    }

    return true;
}

const DEFAULT_PREMIUM = [
    'Bullish Engulfing',
    'Bearish Engulfing',
    'Morning Star',
    'Evening Star',
    'Bullish Doji Star',
    'Bearish Doji Star',
    'Three Inside Up',
    'Three Inside Down',
    'Three Outside Up',
    'Three Outside Down',
    'Three White Soldiers',
    'Three Black Crows',
    'Piercing Line',
    'Dark Cloud Cover',
    'Bullish Abandoned Baby',
    'Bearish Abandoned Baby',
];

const ALLOW_SINGLE = new Set([]);

function attachTradePlan(signal, options = {}) {
    if (!signal) return null;
    const tradePlan = buildTradePlan(signal, options);
    if (!tradePlan) return signal;
    return {
        ...signal,
        tradePlan,
        tradeAction: 'idea_only',
    };
}

function pickEntryCandle(signal) {
    const candles = signal.candles || {};
    if (signal.confirmed && candles.c3) return candles.c3;
    if (candles.c2) return candles.c2;
    return candles.c1 || null;
}

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, digits = 8) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

module.exports = {
    buildTradePlan,
    isHighQualitySignal,
    attachTradePlan,
    DEFAULT_PREMIUM,
};
