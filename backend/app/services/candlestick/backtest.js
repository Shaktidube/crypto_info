const { analyzeForAlert } = require('./index');

function evaluateTradeOutcome(signal, futureCandles) {
    const plan = signal?.tradePlan;
    const direction = signal?.direction;
    if (!plan || !['bullish', 'bearish'].includes(direction)) {
        return { outcome: 'invalid', bars: 0 };
    }

    for (let index = 0; index < futureCandles.length; index += 1) {
        const candle = futureCandles[index];
        const targetHit = direction === 'bullish'
            ? candle.high >= plan.takeProfit1
            : candle.low <= plan.takeProfit1;
        const stopHit = direction === 'bullish'
            ? candle.low <= plan.stopLoss
            : candle.high >= plan.stopLoss;

        // OHLC data cannot tell which level traded first inside one candle.
        if (targetHit && stopHit) {
            return { outcome: 'ambiguous', bars: index + 1 };
        }
        if (targetHit) return { outcome: 'win', bars: index + 1 };
        if (stopHit) return { outcome: 'loss', bars: index + 1 };
    }
    return { outcome: 'unresolved', bars: futureCandles.length };
}

function summarizeTrades(trades) {
    const count = (outcome) => trades.filter(
        (trade) => trade.outcome === outcome,
    ).length;
    const wins = count('win');
    const losses = count('loss');
    const ambiguous = count('ambiguous');
    const unresolved = count('unresolved');
    const resolved = wins + losses;
    const total = trades.length;
    const percent = (numerator, denominator) => denominator
        ? Number(((numerator / denominator) * 100).toFixed(2))
        : null;

    return {
        totalSignals: total,
        wins,
        losses,
        ambiguous,
        unresolved,
        resolved,
        accuracyPercent: percent(wins, resolved),
        conservativeAccuracyPercent: percent(wins, resolved + ambiguous),
        resolutionRatePercent: percent(resolved + ambiguous, total),
    };
}

function backtestCandles(candles, analysisOptions = {}, testOptions = {}) {
    const warmupBars = Number(testOptions.warmupBars) || 120;
    const horizonBars = Number(testOptions.horizonBars) || 30;
    const pair = testOptions.pair || 'unknown';
    const timeframe = testOptions.timeframe || 'unknown';
    const trades = [];

    for (let index = warmupBars - 1;
        index < candles.length - horizonBars; index += 1) {
        // This prefix is the complete information available at signal time.
        // No future candle enters pattern detection or scoring.
        const history = candles.slice(
            Math.max(0, index - warmupBars + 1),
            index + 1,
        );
        const signal = analyzeForAlert(history, analysisOptions);
        if (!signal) continue;

        const outcome = evaluateTradeOutcome(
            signal,
            candles.slice(index + 1, index + 1 + horizonBars),
        );
        trades.push({
            pair,
            timeframe,
            signalTime: candles[index].closeTime,
            pattern: signal.patternName,
            direction: signal.direction,
            confidence: signal.confidence,
            entry: signal.tradePlan?.entryPrice,
            stopLoss: signal.tradePlan?.stopLoss,
            takeProfit1: signal.tradePlan?.takeProfit1,
            ...outcome,
        });
    }

    return { ...summarizeTrades(trades), trades };
}

module.exports = {
    evaluateTradeOutcome,
    summarizeTrades,
    backtestCandles,
};
