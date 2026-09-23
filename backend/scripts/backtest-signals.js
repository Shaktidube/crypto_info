#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { getCandlesticks } = require(
    '../app/services/coindcx/coindcxFuturesClient'
);
const { resolveTimeframe } = require('../app/services/coindcx/timeframes');
const {
    backtestCandles,
    summarizeTrades,
} = require('../app/services/candlestick/backtest');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1]
        ? process.argv[index + 1]
        : fallback;
}

function analysisOptions() {
    return {
        enabledPatterns: config.CANDLE_ENABLED_PATTERNS,
        requireContextMatch: config.CANDLE_REQUIRE_CONTEXT_MATCH,
        requirePriceConfirmation: config.CANDLE_REQUIRE_PRICE_CONFIRMATION,
        highQualityOnly: config.CANDLE_HIGH_QUALITY_ONLY,
        minConfidence: config.CANDLE_MIN_CONFIDENCE,
        tradeSideMode: config.TRADE_SIDE_MODE,
        qualityOptions: {
            minConfidence: config.CANDLE_MIN_CONFIDENCE,
            minConfirmationStrength: config.CANDLE_MIN_CONFIRMATION_STRENGTH,
            requireContextMatch: config.CANDLE_REQUIRE_CONTEXT_MATCH,
            premiumPatternsOnly:
                config.CANDLE_PREMIUM_PATTERNS_ONLY,
            minCandleCount: config.CANDLE_MIN_PATTERN_CANDLES,
        },
        riskOptions: {
            accountBalance: config.TRADE_ACCOUNT_BALANCE,
            accountCurrency: config.TRADE_ACCOUNT_CURRENCY,
            riskPercent: config.TRADE_RISK_PERCENT,
            tp1R: config.TRADE_TP1_R,
            tp2R: config.TRADE_TP2_R,
            tp3R: config.TRADE_TP3_R,
            maxLeverageCap: config.TRADE_MAX_LEVERAGE_CAP,
            leverageSafetyFactor: config.TRADE_LEVERAGE_SAFETY_FACTOR,
            atrBufferMult: config.TRADE_ATR_STOP_BUFFER_MULT,
            maxMarginFraction: config.TRADE_MAX_MARGIN_FRACTION,
        },
        thresholds: {
            haramiRequireConfirmation: config.CANDLE_REQUIRE_CONFIRMATION,
            haramiMinImpulseBodyPercent: config.CANDLE_MIN_IMPULSE_BODY_PERCENT,
            haramiMinAtrMultiplier: config.CANDLE_MIN_ATR_MULTIPLIER,
            haramiMinVolumeMultiplier: config.CANDLE_MIN_VOLUME_MULTIPLIER,
            confirmationMinVolumeMultiplier:
                config.CANDLE_MIN_VOLUME_MULTIPLIER,
            haramiMaxInnerBodyRatio: config.CANDLE_MAX_INNER_BODY_RATIO,
            haramiBodyTolerancePercent: config.CANDLE_BODY_TOLERANCE_PERCENT,
        },
    };
}

async function fetchHistory(pair, timeframe, days) {
    const tf = resolveTimeframe(timeframe);
    const endSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = endSeconds - days * 86400;
    const maxBarsPerRequest = 900;
    const chunkSeconds = (tf.durationMs / 1000) * maxBarsPerRequest;
    const byOpenTime = new Map();

    for (let from = startSeconds; from < endSeconds; from += chunkSeconds) {
        const to = Math.min(endSeconds, from + chunkSeconds);
        const chunk = await getCandlesticks(pair, from, to, timeframe);
        chunk.forEach((candle) => byOpenTime.set(candle.openTime, candle));
    }
    return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
}

async function main() {
    const timeframe = arg('timeframe', config.COINDCX_SCANNER_TIMEFRAME || '1m');
    const days = Number(arg('days', timeframe === '1m' ? 14 : 365));
    const horizonBars = Number(arg('horizon', timeframe === '1m' ? 30 : 12));
    const warmupBars = Number(arg('warmup', 120));
    const pairs = arg(
        'pairs',
        'B-BTC_USDT,B-ETH_USDT,B-SOL_USDT,B-XRP_USDT',
    ).split(',').map((pair) => pair.trim()).filter(Boolean);
    const results = [];

    for (const pair of pairs) {
        process.stderr.write(`Fetching and testing ${pair}...\n`);
        const candles = await fetchHistory(pair, timeframe, days);
        const result = backtestCandles(candles, analysisOptions(), {
            pair, timeframe, horizonBars, warmupBars,
        });
        results.push({ pair, candleCount: candles.length, ...result });
    }

    const trades = results.flatMap((result) => result.trades);
    const report = {
        generatedAt: new Date().toISOString(),
        methodology: {
            timeframe,
            days,
            horizonBars,
            warmupBars,
            target: `TP1 (${config.TRADE_TP1_R}R) before structural stop`,
            lookAhead: false,
            ambiguousRule: 'Reported separately; conservative rate treats as loss.',
        },
        aggregate: summarizeTrades(trades),
        pairs: results.map(({ trades: ignored, ...result }) => result),
        trades,
    };
    const output = arg('output', 'reports/signal-backtest.json');
    const outputPath = path.resolve(__dirname, '..', output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report.aggregate, null, 2)}\n`);
    process.stdout.write(`Report: ${outputPath}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
