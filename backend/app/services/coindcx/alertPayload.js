/**
 * Normalize scanner detection results (legacy or analysis engine)
 * into fields persisted on CandleAlert / returned by admin APIs.
 */
function pickSignalCandle(result) {
    const candles = result?.candles || {};
    if (result?.confirmed && candles.c3) return candles.c3;
    if (candles.c2) return candles.c2;
    if (candles.c1) return candles.c1;
    return null;
}

function buildAlertPayload(pair, symbol, result, timeframe = '1d') {
    const signal = pickSignalCandle(result);
    if (!signal) return null;

    const direction = result.direction ||
        (String(result.patternName || '').toLowerCase().includes('bullish')
            ? 'bullish'
            : String(result.patternName || '').toLowerCase().includes('bearish')
                ? 'bearish'
                : 'unknown');

    return {
        sAlertKey: `${pair}:${timeframe}:${result.patternName}:${signal.openTime}`,
        sPair: pair,
        sSymbol: symbol,
        sTimeframe: timeframe,
        sPatternName: result.patternName,
        sDirection: direction,
        sPatternType: result.type || '',
        nConfidence: Number.isFinite(result.confidence)
            ? result.confidence
            : null,
        oScores: result.scores || null,
        oContext: result.context || null,
        oConfirmation: result.confirmation || null,
        oInvalidation: result.invalidation || null,
        oTradePlan: result.tradePlan || null,
        sExplanation: result.explanation || '',
        dSignalCandleOpenTime: new Date(signal.openTime),
        dSignalCandleCloseTime: new Date(signal.closeTime),
        bIsConfirmed: Boolean(result.confirmed),
        oCandles: result.candles,
        oMetrics: result.metrics,
    };
}

function toLatestSignalView(alert) {
    const doc = typeof alert.toObject === 'function' ? alert.toObject() : alert;
    return {
        sId: String(doc._id),
        sPair: doc.sPair,
        sSymbol: doc.sSymbol,
        sTimeframe: doc.sTimeframe,
        sPatternName: doc.sPatternName,
        sDirection: doc.sDirection || 'unknown',
        sPatternType: doc.sPatternType || '',
        nConfidence: doc.nConfidence,
        oScores: doc.oScores,
        oContext: doc.oContext
            ? {
                trend: doc.oContext.trend,
                strength: doc.oContext.strength,
                matched: doc.oContext.matched,
            }
            : null,
        oInvalidation: doc.oInvalidation,
        oTradePlan: doc.oTradePlan
            ? {
                side: doc.oTradePlan.side,
                entryPrice: doc.oTradePlan.entryPrice,
                stopLoss: doc.oTradePlan.stopLoss,
                takeProfit1: doc.oTradePlan.takeProfit1,
                takeProfit2: doc.oTradePlan.takeProfit2,
                takeProfit3: doc.oTradePlan.takeProfit3,
                riskReward: doc.oTradePlan.riskReward,
                stopDistancePct: doc.oTradePlan.stopDistancePct,
                risk: doc.oTradePlan.risk,
            }
            : null,
        oTradeExecution: doc.oTradeExecution
            ? {
                status: doc.oTradeExecution.status,
                reason: doc.oTradeExecution.reason || '',
                planSummary: doc.oTradeExecution.planSummary || null,
                httpStatus: doc.oTradeExecution.httpStatus || null,
            }
            : null,
        bIsConfirmed: doc.bIsConfirmed,
        eEmailStatus: doc.eEmailStatus,
        dSignalCandleOpenTime: doc.dSignalCandleOpenTime,
        dSignalCandleCloseTime: doc.dSignalCandleCloseTime,
        dCreatedAt: doc.dCreatedAt,
        sExplanation: doc.sExplanation || '',
    };
}

module.exports = {
    pickSignalCandle,
    buildAlertPayload,
    toLatestSignalView,
};
