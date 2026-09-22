/**
 * Parse TRADE_SIDE_MODE from env.
 * Allowed: long | short | both (empty / unset / "all" => both)
 */
function resolveTradeSideMode(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value || value === 'both' || value === 'all' || value === 'any') {
        return 'both';
    }
    if (value === 'long' || value === 'buy' || value === 'bullish') {
        return 'long';
    }
    if (value === 'short' || value === 'sell' || value === 'bearish') {
        return 'short';
    }
    throw new Error(
        `Invalid TRADE_SIDE_MODE "${raw}". Use long, short, or both.`,
    );
}

/**
 * Map signal direction / plan side to long|short|null.
 */
function signalTradeSide(signal) {
    if (!signal) return null;
    if (signal.tradePlan?.side === 'long' || signal.tradePlan?.side === 'short') {
        return signal.tradePlan.side;
    }
    if (signal.direction === 'bullish') return 'long';
    if (signal.direction === 'bearish') return 'short';
    return null;
}

function allowsTradeSide(mode, side) {
    const normalized = resolveTradeSideMode(mode);
    if (normalized === 'both') return true;
    if (!side) return false;
    return normalized === side;
}

module.exports = {
    resolveTradeSideMode,
    signalTradeSide,
    allowsTradeSide,
};
