const mongoose = require('mongoose');
const cron = require('node-cron');
const config = require('../../../config/config');
const { CandleAlert } = require('../../models');
const { nodemailer } = require('../../utils');
const client = require('./coindcxFuturesClient');
const {
    detectBearishHarami,
    analyzeForAlert,
} = require('./candlePatternDetector');
const { buildAlertPayload } = require('./alertPayload');
const { executeSignalOrder } = require('./orderExecutor');
const { allowsTradeSide, signalTradeSide } = require('../candlestick/tradeSideMode');
const {
    resolveTimeframe,
    closedBoundaryMs,
    historyFromSeconds,
    pollLookbackSeconds,
} = require('./timeframes');

function sanitizeError(error) {
    return String(error?.message || error || 'Unknown error').slice(0, 500);
}

function symbolFromPair(pair) {
    return String(pair).replace(/^[A-Z]-/, '').replace('_', '/');
}

function scannerTimeframe() {
    return resolveTimeframe(
        config.COINDCX_SCANNER_TIMEFRAME,
        config.COINDCX_RESOLUTION_OVERRIDE,
    );
}

/** Prefer liquid majors when auto-capping an empty pair list. */
const PREFERRED_PAIRS = [
    'B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT', 'B-XRP_USDT',
    'B-DOGE_USDT', 'B-BNB_USDT', 'B-ADA_USDT', 'B-LINK_USDT',
    'B-AVAX_USDT', 'B-MATIC_USDT',
];

function selectPairs(active, configured) {
    if (configured.length) {
        return active.filter((pair) => configured.includes(pair));
    }
    const max = Number(config.COINDCX_MAX_INSTRUMENTS);
    // 0 / unset = all active instruments
    if (!Number.isFinite(max) || max <= 0) {
        return [...active];
    }
    const preferred = PREFERRED_PAIRS.filter((pair) => active.includes(pair));
    const rest = active.filter((pair) => !preferred.includes(pair)).sort();
    return [...preferred, ...rest].slice(0, max);
}

function buildAlertSubject(alert) {
    const plan = alert.oTradePlan;
    const tf = alert.sTimeframe || scannerTimeframe().label;
    const base = `[CoinDCX Alert] ${alert.sPatternName} — ${alert.sSymbol} — ${tf}`;
    if (!plan) return base;
    const risk = plan.risk || {};
    const cur = risk.currency || 'INR';
    const lev = risk.suggestedLeverage != null ? risk.suggestedLeverage : '?';
    const riskAmt = risk.riskAmount != null ? risk.riskAmount : '';
    const margin = risk.marginRequired != null ? risk.marginRequired : '';
    return `${base} | ${String(plan.side || '').toUpperCase()} lev ${lev}x | risk ${cur} ${riskAmt} | margin ${cur} ${margin} | SL ${plan.stopLoss} TP1 ${plan.takeProfit1}`;
}

class CoinDCXCandleScanner {
    constructor() {
        this.running = false;
        this.starting = null;
        this.pairs = [];
        this.buffers = new Map();
        this.cronTask = null;
        this.polling = false;
        this.skippedPollCount = 0;
        this.refreshTimer = null;
        this.lastCandleAt = null;
        this.lastScanAt = null;
        this.lastAlertAt = null;
        this.lastPollDurationMs = null;
        this.seeding = false;
        this.errors = [];
        this.retryTimers = new Set();
        this.timeframe = null;
        this.cronSchedule = null;
    }

    recordError(error) {
        const message = sanitizeError(error);
        this.errors.unshift({ message, at: new Date() });
        this.errors = this.errors.slice(0, 20);
        console.error('[coindcx-scanner]', message);
    }

    async initialize() {
        if (!config.COINDCX_SCANNER_ENABLED) return;
        try {
            await this.start();
        } catch (error) {
            this.recordError(error);
        }
    }

    async start() {
        if (this.running) return this.status();
        if (this.starting) return this.starting;
        this.starting = this.startInternal().then(() => this.status());
        try {
            return await this.starting;
        } finally {
            this.starting = null;
        }
    }

    async startInternal() {
        if (mongoose.connection.readyState !== 1) {
            throw new Error('MongoDB must be connected before starting CoinDCX scanner');
        }
        const timeframe = scannerTimeframe();
        const cronSchedule = config.COINDCX_CRON_SCHEDULE?.trim() ||
            timeframe.defaultCron;
        if (!cron.validate(cronSchedule)) {
            throw new Error(`Invalid COINDCX_CRON_SCHEDULE: ${cronSchedule}`);
        }
        this.timeframe = timeframe;
        this.cronSchedule = cronSchedule;
        const active = await client.getActiveInstruments(
            config.COINDCX_FUTURES_MARGIN_CURRENCY,
        );
        const configured = config.COINDCX_FUTURES_PAIRS;
        this.pairs = selectPairs(active, configured);
        if (!this.pairs.length) {
            throw new Error('No matching CoinDCX futures instruments');
        }
        if (!configured.length && active.length > this.pairs.length) {
            log.yellow(
                `[coindcx-scanner] capped instruments ${this.pairs.length}/${active.length} (set COINDCX_FUTURES_PAIRS or raise COINDCX_MAX_INSTRUMENTS)`,
            );
        }

        this.running = true;
        // Register cron BEFORE backfill so 1m ticks are not blocked by seeding.
        this.startCron();
        this.refreshTimer = setInterval(
            () => this.refreshInstruments()
                .catch((error) => this.recordError(error)),
            config.COINDCX_ACTIVE_MARKETS_REFRESH_MINUTES * 60 * 1000,
        );

        this.seeding = true;
        this.seedPairs(this.pairs)
            .catch((error) => this.recordError(error))
            .finally(() => {
                this.seeding = false;
                log.green(
                    `[coindcx-scanner] seed complete (${this.pairs.length} pairs)`,
                );
            });
    }

    async seedPairs(pairs) {
        const concurrency = 8;
        for (let offset = 0; offset < pairs.length; offset += concurrency) {
            if (!this.running) return;
            const batch = pairs.slice(offset, offset + concurrency);
            await Promise.all(batch.map(async (pair) => {
                try {
                    await this.backfillPair(pair);
                } catch (error) {
                    this.recordError(
                        new Error(`${pair}: ${sanitizeError(error)}`),
                    );
                }
            }));
        }
    }

    async backfillPair(pair) {
        const tf = this.timeframe || scannerTimeframe();
        const nowSeconds = Math.floor(Date.now() / 1000);
        const from = historyFromSeconds(
            nowSeconds,
            config.COINDCX_HISTORY_CANDLE_COUNT,
            tf.durationMs,
        );
        const candles = await client.getCandlesticks(
            pair, from, nowSeconds, tf.label,
        );
        const boundary = closedBoundaryMs(Date.now(), tf.durationMs);
        const closed = candles
            .filter((candle) => candle.openTime < boundary)
            .slice(-config.COINDCX_HISTORY_CANDLE_COUNT);
        this.buffers.set(pair, closed);
    }

    startCron() {
        if (this.cronTask) {
            this.cronTask.stop();
            this.cronTask = null;
        }
        const schedule = this.cronSchedule ||
            (this.timeframe || scannerTimeframe()).defaultCron;
        this.cronTask = cron.schedule(
            schedule,
            () => this.runCronPoll().catch((error) => this.recordError(error)),
            { timezone: 'UTC' },
        );
        const tf = (this.timeframe || scannerTimeframe()).label;
        log.yellow(
            `[coindcx-scanner] cron scheduled: ${schedule} (${tf}), pairs=${this.pairs.length}`,
        );
    }

    async runCronPoll() {
        if (!this.running) return;
        if (this.polling) {
            this.skippedPollCount += 1;
            log.yellow(
                `[coindcx-scanner] skip tick — previous poll still running (skipped=${this.skippedPollCount})`,
            );
            return;
        }
        this.polling = true;
        this.lastScanAt = new Date();
        const started = Date.now();
        log.cyan(
            `[coindcx-scanner] poll start pairs=${this.pairs.length} seeding=${this.seeding}`,
        );
        try {
            const concurrency = Math.max(1, config.COINDCX_POLL_CONCURRENCY);
            for (let offset = 0; offset < this.pairs.length;
                offset += concurrency) {
                if (!this.running) break;
                const batch = this.pairs.slice(offset, offset + concurrency);
                await Promise.all(batch.map(async (pair) => {
                    try {
                        await this.pollPair(pair);
                    } catch (error) {
                        this.recordError(
                            new Error(`${pair}: ${sanitizeError(error)}`),
                        );
                    }
                }));
            }
        } finally {
            this.polling = false;
            this.lastPollDurationMs = Date.now() - started;
            log.cyan(
                `[coindcx-scanner] poll done in ${this.lastPollDurationMs}ms`,
            );
            if (this.lastPollDurationMs > 55000) {
                this.recordError(new Error(
                    `Poll took ${this.lastPollDurationMs}ms — reduce COINDCX_FUTURES_PAIRS or raise concurrency carefully`,
                ));
            }
        }
    }

    async pollPair(pair) {
        const tf = this.timeframe || scannerTimeframe();
        const nowSeconds = Math.floor(Date.now() / 1000);
        const lookbackSeconds = pollLookbackSeconds(
            tf.durationMs,
            config.COINDCX_POLL_LOOKBACK_CANDLES || tf.pollLookbackCandles,
        );
        const candles = await client.getCandlesticks(
            pair,
            nowSeconds - lookbackSeconds,
            nowSeconds,
            tf.label,
        );
        const boundary = closedBoundaryMs(Date.now(), tf.durationMs);
        const buffer = this.buffers.get(pair) || [];
        let lastOpenTime = buffer.at(-1)?.openTime || 0;
        const newClosedCandles = candles.filter((candle) =>
            candle.openTime < boundary &&
            candle.openTime > lastOpenTime,
        );
        for (const candle of newClosedCandles) {
            this.appendClosedCandle(pair, candle);
            lastOpenTime = candle.openTime;
            this.lastCandleAt = new Date(candle.closeTime);
            await this.analyzePair(pair);
        }
    }

    appendClosedCandle(pair, candle) {
        const buffer = this.buffers.get(pair) || [];
        const withoutSameTime = buffer.filter(
            (row) => row.openTime !== candle.openTime,
        );
        withoutSameTime.push(candle);
        withoutSameTime.sort((a, b) => a.openTime - b.openTime);
        const keep = Math.max(50, config.COINDCX_HISTORY_CANDLE_COUNT);
        this.buffers.set(pair, withoutSameTime.slice(-keep));
    }

    async analyzePair(pair) {
        this.lastScanAt = new Date();
        const buffer = this.buffers.get(pair);
        const legacyOptions = {
            requireConfirmation: config.CANDLE_REQUIRE_CONFIRMATION,
            minImpulseBodyPercent: config.CANDLE_MIN_IMPULSE_BODY_PERCENT,
            minAtrMultiplier: config.CANDLE_MIN_ATR_MULTIPLIER,
            minVolumeMultiplier: config.CANDLE_MIN_VOLUME_MULTIPLIER,
            maxInnerBodyRatio: config.CANDLE_MAX_INNER_BODY_RATIO,
            bodyTolerancePercent: config.CANDLE_BODY_TOLERANCE_PERCENT,
        };

        // Default path preserves historical Bearish Harami alerts.
        // Opt-in engine adds modular context/confirmation/scoring.
        let result = null;
        if (config.CANDLE_USE_ANALYSIS_ENGINE) {
            const signal = analyzeForAlert(buffer, {
                enabledPatterns: config.CANDLE_ENABLED_PATTERNS,
                requireContextMatch: config.CANDLE_REQUIRE_CONTEXT_MATCH,
                highQualityOnly: config.CANDLE_HIGH_QUALITY_ONLY,
                minConfidence: config.CANDLE_MIN_CONFIDENCE,
                tradeSideMode: config.TRADE_SIDE_MODE,
                qualityOptions: {
                    minConfidence: config.CANDLE_MIN_CONFIDENCE,
                    minConfirmationStrength:
                        config.CANDLE_MIN_CONFIRMATION_STRENGTH,
                    requireContextMatch: config.CANDLE_REQUIRE_CONTEXT_MATCH,
                    premiumPatternsOnly: config.CANDLE_PREMIUM_PATTERNS_ONLY,
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
                    haramiRequireConfirmation:
                        config.CANDLE_REQUIRE_CONFIRMATION,
                    haramiMinImpulseBodyPercent:
                        config.CANDLE_MIN_IMPULSE_BODY_PERCENT,
                    haramiMinAtrMultiplier: config.CANDLE_MIN_ATR_MULTIPLIER,
                    haramiMinVolumeMultiplier:
                        config.CANDLE_MIN_VOLUME_MULTIPLIER,
                    haramiMaxInnerBodyRatio:
                        config.CANDLE_MAX_INNER_BODY_RATIO,
                    haramiBodyTolerancePercent:
                        config.CANDLE_BODY_TOLERANCE_PERCENT,
                },
            });
            if (signal) result = signal;
        } else if (config.TRADE_SIDE_MODE !== 'long' &&
            config.CANDLE_ENABLED_PATTERNS
            .some((name) => name.toLowerCase() === 'bearish harami')) {
            result = detectBearishHarami(buffer, legacyOptions);
            if (result) {
                const { attachTradePlan } = require('../candlestick');
                const patternCandles = [result.candles.c1, result.candles.c2,
                    result.candles.c3].filter(Boolean);
                const highs = patternCandles.map((c) => c.high);
                result = attachTradePlan({
                    ...result,
                    direction: 'bearish',
                    type: 'reversal',
                    confidence: 0.6,
                    context: {
                        matched: true, strength: 0.5, trend: 'uptrend',
                    },
                    confirmation: {
                        strength: 0.33, atr: result.metrics?.atr,
                    },
                    metrics: result.metrics,
                    invalidation: {
                        type: 'above_pattern_high',
                        price: Math.max(...highs),
                    },
                }, {
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
                });
            }
        }
        if (!result) return;
        await this.createAndSendAlert(pair, result);
    }

    async createAndSendAlert(pair, result) {
        if (!allowsTradeSide(
            config.TRADE_SIDE_MODE,
            signalTradeSide(result),
        )) {
            return;
        }
        const tf = (this.timeframe || scannerTimeframe()).label;
        const payload = buildAlertPayload(
            pair, symbolFromPair(pair), result, tf,
        );
        if (!payload) return;
        let alert;
        try {
            alert = await CandleAlert.create(payload);
        } catch (error) {
            if (error?.code === 11000) return;
            throw error;
        }

        try {
            const execution = await executeSignalOrder(pair, result, {
                marginCurrency: config.COINDCX_FUTURES_MARGIN_CURRENCY,
                accountCurrency: config.TRADE_ACCOUNT_CURRENCY,
                usdtInrRate: config.TRADE_USDT_INR_RATE,
            });
            await CandleAlert.findByIdAndUpdate(alert._id, {
                oTradeExecution: execution,
            });
            alert.oTradeExecution = execution;
            if (execution.status === 'failed' ||
                execution.status === 'rejected') {
                this.recordError(new Error(
                    `${pair} auto-trade ${execution.status}: ${execution.reason || execution.httpStatus || 'unknown'}`,
                ));
                if (execution.httpStatus === 401) {
                    this.recordError(new Error(
                        'CoinDCX 401 Invalid credentials — check API key/secret and Futures Trade permission, keep AUTO_TRADE_DRY_RUN=true until fixed',
                    ));
                }
            }
        } catch (error) {
            const message = sanitizeError(error);
            await CandleAlert.findByIdAndUpdate(alert._id, {
                oTradeExecution: { status: 'error', reason: message },
            });
            this.recordError(new Error(`${pair} auto-trade error: ${message}`));
        }

        await this.deliverAlert(alert);
    }

    async deliverAlert(alert) {
        if (!config.CANDLE_ALERT_EMAIL_TO) {
            await CandleAlert.findByIdAndUpdate(alert._id, {
                eEmailStatus: 'Failed',
                sEmailError: 'CANDLE_ALERT_EMAIL_TO is not configured',
            });
            return;
        }
        const claimed = await CandleAlert.findOneAndUpdate(
            { _id: alert._id, eEmailStatus: { $in: ['Pending', 'Failed'] }, nEmailAttempts: { $lt: 3 } },
            { $set: { eEmailStatus: 'Sending', sEmailError: '' }, $inc: { nEmailAttempts: 1 } },
            { new: true },
        );
        if (!claimed) return;
        try {
            await nodemailer.send('coindcx_candle_alert.html', {
                alert: claimed.toObject(),
                utcTime: claimed.dSignalCandleCloseTime.toLocaleString('en-GB', { timeZone: 'UTC' }),
                indiaTime: claimed.dSignalCandleCloseTime.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }),
            }, {
                from: config.SMTP_FROM,
                to: config.CANDLE_ALERT_EMAIL_TO,
                subject: buildAlertSubject(claimed),
            });
            await CandleAlert.findByIdAndUpdate(claimed._id, {
                eEmailStatus: 'Sent', dEmailSentAt: new Date(), sEmailError: '',
            });
            this.lastAlertAt = new Date();
        } catch (error) {
            await CandleAlert.findByIdAndUpdate(claimed._id, {
                eEmailStatus: 'Failed', sEmailError: sanitizeError(error),
            });
            this.recordError(error);
            if (claimed.nEmailAttempts < 3) {
                const timer = setTimeout(async () => {
                    this.retryTimers.delete(timer);
                    try {
                        const retryAlert = await CandleAlert.findById(
                            claimed._id,
                        );
                        if (retryAlert) await this.deliverAlert(retryAlert);
                    } catch (retryError) {
                        this.recordError(retryError);
                    }
                }, 30000 * claimed.nEmailAttempts);
                this.retryTimers.add(timer);
            }
        }
    }

    async refreshInstruments() {
        if (!this.running || this.polling) return;
        const active = await client.getActiveInstruments(
            config.COINDCX_FUTURES_MARGIN_CURRENCY,
        );
        const selected = selectPairs(active, config.COINDCX_FUTURES_PAIRS);
        if (selected.join(',') === this.pairs.join(',')) return;
        await this.stop();
        await this.start();
    }

    async sendTestEmail() {
        if (!config.CANDLE_ALERT_EMAIL_TO) {
            throw new Error('CANDLE_ALERT_EMAIL_TO is not configured');
        }
        await nodemailer.sendMail({
            from: config.SMTP_FROM,
            to: config.CANDLE_ALERT_EMAIL_TO,
            subject: '[CoinDCX Futures Alert] SMTP test',
            text: 'CoinDCX Futures candle scanner SMTP configuration is working.',
        });
    }

    async stop() {
        this.running = false;
        this.seeding = false;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        if (this.cronTask) this.cronTask.stop();
        this.cronTask = null;
        for (const timer of this.retryTimers) clearTimeout(timer);
        this.retryTimers.clear();
        this.polling = false;
        return this.status();
    }

    status() {
        const tf = this.timeframe || scannerTimeframe();
        return {
            bIsEnabled: config.COINDCX_SCANNER_ENABLED,
            bIsRunning: this.running,
            bIsStarting: Boolean(this.starting),
            bIsSeeding: Boolean(this.seeding),
            bHasCronTask: Boolean(this.cronTask),
            sMode: 'cron-rest',
            sTimeframe: tf.label,
            sResolution: tf.resolution,
            nDurationMs: tf.durationMs,
            sCronSchedule: this.cronSchedule || tf.defaultCron,
            bIsPolling: this.polling,
            nInstrumentCount: this.pairs.length,
            nSkippedPollCount: this.skippedPollCount,
            nLastPollDurationMs: this.lastPollDurationMs,
            dLastCandleAt: this.lastCandleAt,
            dLastScanAt: this.lastScanAt,
            dLastAlertAt: this.lastAlertAt,
            aRecentErrors: this.errors,
            oDetection: {
                bUseAnalysisEngine: config.CANDLE_USE_ANALYSIS_ENGINE,
                aEnabledPatterns: config.CANDLE_ENABLED_PATTERNS,
                bRequireContextMatch: config.CANDLE_REQUIRE_CONTEXT_MATCH,
                nMinConfidence: config.CANDLE_MIN_CONFIDENCE,
                sTradeSideMode: config.TRADE_SIDE_MODE,
                bHighQualityOnly: config.CANDLE_HIGH_QUALITY_ONLY,
                bPremiumPatternsOnly: config.CANDLE_PREMIUM_PATTERNS_ONLY,
                nMinConfirmationStrength:
                    config.CANDLE_MIN_CONFIRMATION_STRENGTH,
                oRiskDefaults: {
                    sCurrency: config.TRADE_ACCOUNT_CURRENCY,
                    nAccountBalance: config.TRADE_ACCOUNT_BALANCE,
                    nRiskPercent: config.TRADE_RISK_PERCENT,
                    nMaxLeverageCap: config.TRADE_MAX_LEVERAGE_CAP,
                    nMaxMarginFraction: config.TRADE_MAX_MARGIN_FRACTION,
                    nTp1R: config.TRADE_TP1_R,
                    nTp2R: config.TRADE_TP2_R,
                    nTp3R: config.TRADE_TP3_R,
                },
                oAutoTrade: {
                    bEnabled: config.AUTO_TRADE_ENABLED,
                    bDryRun: config.AUTO_TRADE_DRY_RUN,
                    sMarket: config.AUTO_TRADE_MARKET,
                    sSpotQuote: config.AUTO_TRADE_SPOT_QUOTE,
                    sMarginCurrency: config.COINDCX_FUTURES_MARGIN_CURRENCY,
                    nUsdtInrRate: config.TRADE_USDT_INR_RATE,
                },
            },
        };
    }
}

module.exports = new CoinDCXCandleScanner();
