#!/usr/bin/env node
/**
 * CLI: load a user’s Kraken API key from MongoDB, fetch all Ledgers, run the same FIFO
 * helpers as production (krakenStatsLedgerFifoHelpers), and print a text report.
 *
 * After the ledger-only FIFO report, also runs `computeKrakenStats` (same as the user
 * passport/profile API) and prints that JSON so you can compare with the live response.
 *
 * Shared logic lives in ../app/utils/lib/krakenStatsLedgerFifoHelpers.js — this file wires
 * DB + printing only.
 */
/* eslint-disable no-console */
require('dotenv').config();

const mongoose = require('mongoose');
const { User } = require('../app/models');
const config = require('../config/config');
const {
    createCcxtApiFn,
    computeKrakenStats,
    refreshKrakenToken,
    getFastApiKey,
    deleteAllTinkaFastApiKeys,
} = require('../app/utils/lib/krakenStats');
const {
    calcROI,
    formatROI,
    groupByRefId,
    summarizeLedgerCoverage,
    addFeeInAmount,
    passThroughLedgerAmounts,
    createApplyLedgerAmountsForFifo,
    runFIFO,
    KRAKEN_LEDGER_FIFO_FIAT_ASSETS,
} = require('../app/utils/lib/krakenStatsLedgerFifoHelpers');

/** Kraken ledger / FIFO codes treated as USD-pegged stables (not ZUSD fiat). */
const STABLECOIN_ASSETS = new Set([
    'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE', 'ZUSDT', 'ZUSDC',
]);

function isStablecoinAsset(asset) {
    const code = String(asset || '').trim().toUpperCase();
    return STABLECOIN_ASSETS.has(code);
}

function isFiatOrStableFifoLeg(asset) {
    return KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(String(asset || ''));
}

function classifyLedgerFifoTrade(trade) {
    const soldFiat = isFiatOrStableFifoLeg(trade.soldAsset);
    const boughtFiat = isFiatOrStableFifoLeg(trade.boughtAsset);
    if (soldFiat && !boughtFiat) return 'buy_crypto';
    if (!soldFiat && boughtFiat) return 'sell_crypto';
    if (soldFiat && boughtFiat) return 'fiat_stable_swap';
    return 'crypto_swap';
}

const emailArg = (process.argv[2] || '').toLowerCase().trim();

// ─── How to treat ledger row fees before FIFO ─────────────────────────

// Comment exactly one line (no env vars). See krakenStatsLedgerFifoHelpers for behaviour.
const applyLedgerAmountsForFifo = createApplyLedgerAmountsForFifo(true); // fees on buy + sell
// const applyLedgerAmountsForFifo = createApplyLedgerAmountsForFifo('buyOnly'); // fees on buys only
// const applyLedgerAmountsForFifo = createApplyLedgerAmountsForFifo(false); // gross

// ─── Formatting (script-only) ────────────────────────────────────────

/**
 * Format a signed number for display (e.g. +1.05 or -0.30).
 */
function formatSigned(num, decimals = 4) {
    const sign = num >= 0 ? '+' : '';
    return `${sign}${num.toFixed(decimals)}`;
}

// ─── CLI help text ─────────────────────────────────────────────────────

/** Prints how to run the script and relevant environment toggles. */
function usage() {
    console.log(
        'Usage: node scripts/kraken-stats-debug.js <user-email>\n' +
            'Example: node scripts/kraken-stats-debug.js user@example.com\n' +
            '\nOptional env:\n' +
            '  KRAKEN_DEBUG_LEDGER_PAIRS=0 — skip ledger-by-refid dump\n' +
            '  Ledger fees in FIFO: edit createApplyLedgerAmountsForFifo lines near top of script ' +
            '(comment one line, see krakenStatsLedgerFifoHelpers.js)\n' +
            '\nThe script ends with a JSON block from computeKrakenStats (same object the ' +
            'profile/passport API returns in stats).\n',
    );
}

// ─── Pretty-print raw ledger data ─────────────────────────────────────

/**
 * Prints all ledger lines grouped by refid (helpful to see spend/receive pairs).
 * Large accounts: set env KRAKEN_DEBUG_LEDGER_PAIRS=0 to skip this dump.
 *
 * @param {Object<string, Object>} ledgerObj - Kraken `result.ledger` map.
 */
function printAllLedgerPairs(ledgerObj) {
    const ledger = ledgerObj || {};
    const refGroups = groupByRefId(ledger);
    const sortedRefs = Object.keys(refGroups).sort((a, b) => {
        const minTime = (arr) =>
            arr.reduce(
                (m, e) => Math.min(m, Number(e.time) || 0),
                Infinity,
            );
        return minTime(refGroups[a]) - minTime(refGroups[b]);
    });

    console.log(
        '\n── ALL LEDGER ROWS BY refid (same refid = same Kraken booking) ──\n',
    );
    let spendReceiveGroups = 0;
    for (const refKey of sortedRefs) {
        const entries = refGroups[refKey]
            .slice()
            .sort(
                (x, y) =>
                    Number(x.time) - Number(y.time) ||
                    String(x.ledgerId).localeCompare(String(y.ledgerId)),
            );
        const hasSpend = entries.some((e) => e.type === 'spend');
        const hasRecv = entries.some((e) => e.type === 'receive');
        if (hasSpend && hasRecv) spendReceiveGroups += 1;

        let refLabel = refKey;
        if (refKey === 'null' || refKey === 'undefined') {
            refLabel = '(missing refid)';
        } else if (refKey === '') {
            refLabel = '(empty refid)';
        }

        const t0 = entries[0]?.time;
        const dateStr =
            t0 != null
                ? new Date(Number(t0) * 1000).toISOString()
                : '?';
        const kind = entries.every((e) => e.type === 'staking')
            ? 'staking'
            : hasSpend && hasRecv
              ? 'spend+receive'
              : 'other';

        console.log(
            `  refid ${refLabel}  |  ${entries.length} row(s)  |  ${kind}  |  earliest ${dateStr}`,
        );
        for (const e of entries) {
            const amt = parseFloat(String(e.amount || 0));
            const fee = parseFloat(String(e.fee || 0));
            console.log(
                `    ${e.ledgerId}  ${e.type}  ${e.asset}  amount=${amt}  fee=${fee}  time=${e.time}`,
            );
        }
        console.log();
    }
    console.log(
        `  Total refid groups: ${sortedRefs.length}  (${spendReceiveGroups} with both spend and receive)\n`,
    );
}

/**
 * Prints every ledger row as JSON (chronological) right after fetch.
 * @param {Object<string, Object>} ledgerObj - Kraken `result.ledger` map.
 */
function printCompleteLedgerData(ledgerObj) {
    const ledger = ledgerObj || {};
    const rows = Object.entries(ledger).map(([ledgerId, row]) => ({
        ledgerId,
        ...row,
    }));
    rows.sort(
        (a, b) =>
            Number(a.time || 0) - Number(b.time || 0) ||
            String(a.ledgerId).localeCompare(String(b.ledgerId)),
    );
    console.log('\n── COMPLETE LEDGER DATA (all fetched rows) ──\n');
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\n── end complete ledger (${rows.length} rows) ──\n`);
}

/**
 * Reports whether stablecoin ledger activity flows into headline ROI (ledger FIFO path).
 * @param {Object<string, Object>} ledgerObj
 * @param {Object} fifoResult - Output of calculateFIFOProfitLoss.
 */
function printStablecoinRoiAnalysis(ledgerObj, fifoResult) {
    const ledger = ledgerObj || {};
    const refGroups = groupByRefId(ledger);
    const { trades: fifoInputTrades } = parseTrades(refGroups);
    const realisedPnL = fifoResult.trades || [];

    const stableLedgerRows = [];
    for (const [ledgerId, row] of Object.entries(ledger)) {
        if (isStablecoinAsset(row.asset)) {
            stableLedgerRows.push({ ledgerId, ...row });
        }
    }

    const stableByAsset = {};
    for (const row of stableLedgerRows) {
        const a = row.asset;
        stableByAsset[a] = (stableByAsset[a] || 0) + 1;
    }

    const fifoWithStableLeg = fifoInputTrades.filter(
        (t) => isStablecoinAsset(t.soldAsset) || 
        isStablecoinAsset(t.boughtAsset),
    );
    const fifoStableBuys = fifoInputTrades.filter(
        (t) =>
            classifyLedgerFifoTrade(t) === 'buy_crypto' &&
            isStablecoinAsset(t.soldAsset),
    );
    const fifoStableSells = fifoInputTrades.filter(
        (t) =>
            classifyLedgerFifoTrade(t) === 'sell_crypto' &&
            isStablecoinAsset(t.boughtAsset),
    );
    const skippedStableSwaps = fifoInputTrades.filter(
        (t) => classifyLedgerFifoTrade(t) === 'fiat_stable_swap',
    );

    const realisedWithStableProceeds = realisedPnL.filter((r) =>
        isStablecoinAsset(r.fiatCurrency),
    );
    const stablePnl = realisedWithStableProceeds.reduce(
        (s, r) => s + r.profitLoss,
        0,
    );
    const stableCost = realisedWithStableProceeds.reduce(
        (s, r) => s + r.costBasis,
        0,
    );
    const totalPnl = fifoResult.totalRealisedPnL ?? 0;
    const totalCost = fifoResult.totalCostBasis ?? 0;

    const includedInRoi =
        fifoStableBuys.length > 0 ||
        realisedWithStableProceeds.length > 0;

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  STABLECOIN vs ROI (ledger FIFO — same helpers as production)');
    console.log('══════════════════════════════════════════════════════════════\n');

    console.log('1) Stablecoins in raw ledger fetch:');
    if (stableLedgerRows.length === 0) {
        console.log('   None found (no USDT/USDC/DAI/TUSD/PYUSD/USDE/ZUSDT/ZUSDC rows).');
    } else {
        console.log(`   ${stableLedgerRows.length} ledger row(s):`);
        for (const [asset, count] of Object.entries(stableByAsset).sort()) {
            console.log(`     ${asset}: ${count}`);
        }
    }

    console.log('\n2) FIFO routing (KRAKEN_LEDGER_FIFO_FIAT_ASSETS includes stables):');
    console.log(
        `   Paired spend+receive trades with a stablecoin leg: ${fifoWithStableLeg.length}`,
    );
    console.log(`   Buys funded with stablecoin (cost basis in USDT etc.): ${fifoStableBuys.length}`);
    console.log(`   Sells settled in stablecoin (proceeds in USDT etc.): ${fifoStableSells.length}`);
    console.log(
        `   Stable↔stable / fiat-only pairs (not crypto ROI legs): ${skippedStableSwaps.length}`,
    );
    if (skippedStableSwaps.length > 0) {
        console.log('   Examples (spend → receive):');
        for (const t of skippedStableSwaps.slice(0, 12)) {
            console.log(
                `     ${t.date?.slice(0, 10) ?? '?'} | ${t.soldAmount?.toFixed?.(4) ?? t.soldAmount} ${t.soldAsset} → ${t.boughtAmount?.toFixed?.(4) ?? t.boughtAmount} ${t.boughtAsset}`,
            );
        }
        if (skippedStableSwaps.length > 12) {
            console.log(`     … and ${skippedStableSwaps.length - 12} more`);
        }
    }

    const realisedByProceeds = {};
    for (const r of realisedPnL) {
        const f = r.fiatCurrency || '(unknown)';
        if (!realisedByProceeds[f]) {
            realisedByProceeds[f] = { count: 0, pnl: 0, cost: 0 };
        }
        realisedByProceeds[f].count += 1;
        realisedByProceeds[f].pnl += r.profitLoss;
        realisedByProceeds[f].cost += r.costBasis;
    }

    console.log('\n3) Realised sells that count toward headline ROI:');
    console.log(
        `   Total realised sell legs: ${realisedPnL.length}`,
    );
    console.log(
        `   Sells with stablecoin proceeds: ${realisedWithStableProceeds.length}`,
    );
    if (Object.keys(realisedByProceeds).length > 0) {
        console.log('   Proceeds currency breakdown (all realised sells):');
        for (const [asset, s] of Object.entries(realisedByProceeds).sort()) {
            const tag = isStablecoinAsset(asset) ? ' ← stablecoin' : '';
            console.log(
                `     ${asset}: ${s.count} sell(s) | P&L ${s.pnl.toFixed(4)} | cost ${s.cost.toFixed(4)}${tag}`,
            );
        }
    }
    if (realisedWithStableProceeds.length > 0) {
        const byProceedsAsset = {};
        for (const r of realisedWithStableProceeds) {
            const a = r.fiatCurrency;
            if (!byProceedsAsset[a]) {
                byProceedsAsset[a] = { count: 0, pnl: 0, cost: 0 };
            }
            byProceedsAsset[a].count += 1;
            byProceedsAsset[a].pnl += r.profitLoss;
            byProceedsAsset[a].cost += r.costBasis;
        }
        for (const [asset, s] of Object.entries(byProceedsAsset)) {
            console.log(
                `     ${asset}: ${s.count} sell(s) | P&L ${s.pnl.toFixed(4)} | cost ${s.cost.toFixed(4)} | ROI ${formatROI(calcROI(s.pnl, s.cost))}`,
            );
        }
    }

    const openStables = fifoResult.remainingHoldings || {};
    const openStableKeys = Object.keys(openStables).filter(isStablecoinAsset);
    if (openStableKeys.length > 0) {
        console.log('\n   Open stablecoin FIFO lots (not in realised ROI until spent on crypto or withdrawn):');
        for (const key of openStableKeys) {
            const h = openStables[key];
            console.log(
                `     ${key}: ${h.totalAmount?.toFixed?.(6) ?? h.totalAmount} (book cost ${h.totalCostBasis?.toFixed?.(4) ?? h.totalCostBasis})`,
            );
        }
    }

    console.log('\n4) Contribution to overall ROI (this ledger run):');
    console.log(
        `   Total realised P&L: ${totalPnl.toFixed(4)} | cost basis: ${totalCost.toFixed(4)} | ROI: ${formatROI(fifoResult.overallROI)}`,
    );
    if (realisedWithStableProceeds.length > 0 && totalCost > 0) {
        const pctOfCost = ((stableCost / totalCost) * 100).toFixed(1);
        const pctOfPnl = totalPnl !== 0 ? ((stablePnl / totalPnl) * 100).toFixed(1) : 'n/a';
        console.log(
            `   From stablecoin-settled sells: P&L ${stablePnl.toFixed(4)} (${pctOfPnl}% of total P&L) | cost ${stableCost.toFixed(4)} (${pctOfCost}% of cost basis)`,
        );
    }

    console.log('\n5) Verdict:');
    if (stableLedgerRows.length === 0) {
        console.log(
            '   No stablecoin data in ledger → stablecoins do NOT affect ROI for this account (ledger path).',
        );
    } else if (includedInRoi) {
        console.log(
            '   YES — stablecoin legs ARE included in ROI when used as the quote on crypto buy/sell.',
        );
        console.log(
            '   (Stablecoins are the fiat/quote leg, not a separate “best asset”. Pure stable↔stable moves are excluded.)',
        );
    } else {
        console.log(
            '   Stablecoins in ledger, but NONE used as quote on crypto buy/sell in this ledger FIFO run.',
        );
        const proceedsCurrencies = Object.keys(realisedByProceeds).join(', ') || '(none)';
        console.log(
            `   Your ${realisedPnL.length} realised sells settled in: ${proceedsCurrencies} (not USDT/USDC).`,
        );
        console.log(
            '   The 8 stablecoin ledger pairs are fiat↔stable conversions (e.g. USDT↔ZAUD) — excluded from crypto ROI.',
        );
        if (openStableKeys.length > 0) {
            console.log(
                '   USDT/USDC in “Remaining holdings” are open balances — not counted in realised ROI until used.',
            );
        }
        console.log(
            '   Passport production ROI may still include USDT pairs from TradesHistory spot fills (see API stats JSON below).',
        );
    }

    console.log(
        '\n   Note: Production passport ROI also merges TradesHistory spot fills (e.g. ETHUSDT pairs).',
    );
    console.log('══════════════════════════════════════════════════════════════\n');
}

/**
 * Turns refid groups into FIFO-ready trades plus a separate staking bucket.
 *
 * Rules:
 * - Both `spend` and `receive` under the same refid → one trade (amounts shaped by
 *   applyLedgerAmountsForFifo above).
 * - Only staking rows under a refid → summed into stakingRewards (not in FIFO).
 * - Deposits, withdrawals, or single-sided refids → skipped here (still in raw ledger).
 *
 * @param {Object<string, Array>} refGroups - Output of groupByRefId(ledger).
 * @returns {{ trades: Array<Object>, stakingRewards: Object<string, number> }}
 */
function parseTrades(refGroups) {
    const trades = [];
    const stakingRewards = {};

    for (const [refid, entries] of Object.entries(refGroups)) {
        if (entries.every((e) => e.type === 'staking')) {
            for (const e of entries) {
                if (!stakingRewards[e.asset]) stakingRewards[e.asset] = 0;
                stakingRewards[e.asset] += parseFloat(e.amount);
            }
            continue;
        }

        const spendEntry = entries.find((e) => e.type === 'spend');
        const receiveEntry = entries.find((e) => e.type === 'receive');
        if (!spendEntry || !receiveEntry) continue;

        const rawTrade = {
            refid,
            time: spendEntry.time,
            date: new Date(spendEntry.time * 1000).toISOString(),
            soldAsset: spendEntry.asset,
            soldAmount: Math.abs(parseFloat(spendEntry.amount)),
            soldFee: parseFloat(spendEntry.fee || 0),
            boughtAsset: receiveEntry.asset,
            boughtAmount: parseFloat(receiveEntry.amount),
            boughtFee: parseFloat(receiveEntry.fee || 0),
        };
        trades.push(applyLedgerAmountsForFifo(rawTrade));
    }

    trades.sort((a, b) => a.time - b.time);
    return { trades, stakingRewards };
}

// ─── Roll up FIFO sell results by asset ─────────────────────────────────

/**
 * Aggregates each processSell output into totals per crypto asset (proceeds, cost, P&L).
 *
 * @param {Array<Object>} realisedPnL - Rows returned from runFIFO (sell legs only).
 * @returns {Object<string, Object>} Per-asset summary objects.
 */
function buildAssetSummary(realisedPnL) {
    const summary = {};

    for (const pnl of realisedPnL) {
        if (!summary[pnl.asset]) {
            summary[pnl.asset] = {
                asset: pnl.asset,
                totalProceeds: 0,
                totalCostBasis: 0,
                totalProfitLoss: 0,
                tradeCount: 0,
                roi: null,
                fiatCurrency: pnl.fiatCurrency,
                trades: [],
            };
        }
        summary[pnl.asset].totalProceeds += pnl.proceeds;
        summary[pnl.asset].totalCostBasis += pnl.costBasis;
        summary[pnl.asset].totalProfitLoss += pnl.profitLoss;
        summary[pnl.asset].tradeCount++;
        summary[pnl.asset].trades.push(pnl);
    }

    for (const s of Object.values(summary)) {
        s.roi = calcROI(s.totalProfitLoss, s.totalCostBasis);
    }

    return summary;
}

/**
 * Picks highlight rows for the printed report: best/worst by ROI (where cost basis exists)
 * and by absolute profit.
 *
 * @param {Object<string, Object>} summary - From buildAssetSummary.
 * @returns {Object|null} bestByROI, worstByROI, bestByProfit, worstByProfit (or null if empty).
 */
function findBestPerformer(summary) {
    const assets = Object.values(summary);
    if (assets.length === 0) return null;

    const extractDetails = (a) => ({
        asset: a.asset,
        roi: a.roi,
        profitLoss: a.totalProfitLoss,
        costBasis: a.totalCostBasis,
        proceeds: a.totalProceeds,
        tradeCount: a.tradeCount,
        fiatCurrency: a.fiatCurrency,
    });

    // Assets with tracked cost basis (ROI is calculable)
    const withROI = assets.filter((a) => a.roi !== null && a.roi !== undefined);

    const bestByROI = withROI.length > 0
        ? extractDetails(
            withROI.reduce((best, a) => (a.roi > best.roi ? a : best)),
        )
        : null;

    const worstByROI = withROI.length > 0
        ? extractDetails(
            withROI.reduce((worst, a) => (a.roi < worst.roi ? a : worst)),
        )
        : null;

    const bestByProfit = extractDetails(
        assets.reduce(
            (best, a) => (a.totalProfitLoss > best.totalProfitLoss ? a : best),
        ),
    );

    const worstByProfit = extractDetails(
        assets.reduce((worst, a) => {
            return a.totalProfitLoss < worst.totalProfitLoss ? a : worst;
        }),
    );

    return { bestByROI, bestByProfit, worstByProfit, worstByROI };
}

/**
 * After runFIFO, lists crypto still held in open lots (amount and book cost per lot).
 *
 * @param {Object<string, Array>} fifoQueues - Same object returned by runFIFO.
 * @returns {Object<string, Object>}
 */
function buildRemainingHoldings(fifoQueues) {
    const remainingHoldings = {};
    for (const [asset, queue] of Object.entries(fifoQueues)) {
        const totalRemaining = queue.reduce((sum, lot) => sum + lot.amount, 0);
        if (totalRemaining > 0.000000001) {
            remainingHoldings[asset] = {
                totalAmount: totalRemaining,
                lots: queue.map((l) => ({
                    amount: l.amount,
                    costPerUnit: l.costPerUnit,
                    date: l.date,
                    note: l.note,
                })),
                totalCostBasis: queue.reduce(
                    (sum, l) => sum + l.amount * l.costPerUnit,
                    0,
                ),
            };
        }
    }
    return remainingHoldings;
}

/**
 * Single-line totals across all realised sells: sum P&L, cost, proceeds, overall ROI.
 *
 * @param {Array<Object>} realisedPnL
 * @returns {{ totalRealisedPnL, totalCostBasis, totalProceeds, overallROI, tradeCount }}
 */
function buildOverallStats(realisedPnL) {
    const totalRealisedPnL = realisedPnL.reduce((s, t) => s + t.profitLoss, 0);
    const totalCostBasis = realisedPnL.reduce((s, t) => s + t.costBasis, 0);
    const totalProceeds = realisedPnL.reduce((s, t) => s + t.proceeds, 0);
    const overallROI = calcROI(totalRealisedPnL, totalCostBasis);

    return {
        totalRealisedPnL,
        totalCostBasis,
        totalProceeds,
        overallROI,
        tradeCount: realisedPnL.length,
    };
}

// ─── End-to-end ledger → FIFO report ──────────────────────────────────

/**
 * Full pipeline: group by refid → parse paired trades → runFIFO (processBuy/Sell/Swap) →
 * summaries for the console report.
 *
 * @param {{ ledger: Object<string, Object> }} ledgerResponse - Merged Ledgers API result.
 * @returns {Object} Realised trades, per-asset summary, best/worst, staking map, open lots, totals.
 */
function calculateFIFOProfitLoss(ledgerResponse) {
    const { ledger } = ledgerResponse;

    // console.log("ledgerResponse", ledgerResponse);

    const refGroups = groupByRefId(ledger);
    const { trades, stakingRewards } = parseTrades(refGroups);
    // console.log("trades", trades);
    // console.log("stakingRewards", stakingRewards);
    const { realisedPnL, fifoQueues } = runFIFO(trades);
    // console.log("realisedPnL", realisedPnL);
    // console.log("fifoQueues", fifoQueues);
    const summary = buildAssetSummary(realisedPnL);
    // console.log("summary", summary);
    const bestPerformer = findBestPerformer(summary);
    // console.log("bestPerformer", bestPerformer);
    const remainingHoldings = buildRemainingHoldings(fifoQueues);
    const overallStats = buildOverallStats(realisedPnL);

    return {
        trades: realisedPnL,
        summary,
        bestPerformer,
        stakingRewards, // kept for info only — NOT mixed into P&L, ROI, or FIFO
        remainingHoldings,
        ...overallStats,
    };
}

// ─── Console report sections (mostly stubs; extend when you need detail) ─────

/** Placeholder section header for per-trade lines (body commented out). */
function printTradeBreakdown(trades) {
    console.log('── TRADE-BY-TRADE BREAKDOWN ──\n');
    // for (const t of trades) {
    //     console.log(
    //         `  ${t.date.slice(0, 10)} | Sold ${t.soldAmount.toFixed(6)} ${t.asset}`,
    //     );
    //     console.log(
    //         `    Proceeds: ${t.proceeds.toFixed(4)} ${t.fiatCurrency} | ` +
    //             `Cost: ${t.costBasis.toFixed(4)} | P&L: ` +
    //             `${formatSigned(t.profitLoss)} ${t.fiatCurrency} | ` +
    //             `ROI: ${formatROI(t.roi)}`,
    //     );
    //     console.log(
    //         `    FIFO lots: ${t.lotsUsed.map((l) =>
    //             `${l.amount.toFixed(6)} @ ${l.costPerUnit.toFixed(4)}/unit ` +
    //             `(${l.date.slice(0, 10)})`).join(', ')}`,
    //     );
    //     console.log();
    // }
    void trades;
}

/** Placeholder for per-asset table (body commented out). */
function printAssetSummary(summary) {
    console.log('── SUMMARY BY ASSET ──\n');
    // for (const [asset, s] of Object.entries(summary)) {
    //     // console.log(`  ${asset}:`);
    //     // console.log(
    //     //     `    ${s.tradeCount} trade(s) | Proceeds: ${s.totalProceeds.toFixed(4)} | Cost: ${s.totalCostBasis.toFixed(4)} | P&L: ${formatSigned(s.totalProfitLoss)} ${s.fiatCurrency} | ROI: ${formatROI(s.roi)}`,
    //     // );
    // }
    // console.log();
}

/** Prints best/worst assets from findBestPerformer (ROI and profit). */
function printBestPerformer(bp) {
    if (!bp) {
        console.log('── BEST PERFORMER: No trades to evaluate ──\n');
        return;
    }

    console.log('══════════════════════════════════════════════════════════════');
    console.log('  BEST & WORST PERFORMING ASSETS');
    console.log('══════════════════════════════════════════════════════════════\n');

    if (bp.bestByROI) {
        const b = bp.bestByROI;
        console.log(`  🏆 Best by ROI:       ${b.asset}`);
        console.log(`     ROI: ${formatROI(b.roi)} | P&L: ${formatSigned(b.profitLoss)} ${b.fiatCurrency}`);
        console.log(`     Cost: ${b.costBasis.toFixed(4)} → Proceeds: ${b.proceeds.toFixed(4)} (${b.tradeCount} trade(s))`);
    } else {
        console.log('  🏆 Best by ROI:       N/A (no assets with tracked cost basis)');
    }

    const p = bp.bestByProfit;
    console.log(`  💰 Best by Profit:    ${p.asset}`);
    console.log(`     ROI: ${formatROI(p.roi)} | P&L: ${formatSigned(p.profitLoss)} ${p.fiatCurrency}`);
    console.log(`     Cost: ${p.costBasis.toFixed(4)} → Proceeds: ${p.proceeds.toFixed(4)} (${p.tradeCount} trade(s))`);

    const w = bp.worstByProfit;
    console.log(`  📉 Worst by Profit:   ${w.asset}`);
    console.log(`     ROI: ${formatROI(w.roi)} | P&L: ${formatSigned(w.profitLoss)} ${w.fiatCurrency}`);
    console.log(`     Cost: ${w.costBasis.toFixed(4)} → Proceeds: ${w.proceeds.toFixed(4)} (${w.tradeCount} trade(s))`);

    if (bp.worstByROI) {
        const wr = bp.worstByROI;
        console.log(`  📉 Worst by ROI:      ${wr.asset}`);
        console.log(`     ROI: ${formatROI(wr.roi)} | P&L: ${formatSigned(wr.profitLoss)} ${wr.fiatCurrency}`);
        console.log(`     Cost: ${wr.costBasis.toFixed(4)} → Proceeds: ${wr.proceeds.toFixed(4)} (${wr.tradeCount} trade(s))`);
    }

    console.log();
}

/** One-line headline: total realised P&L, cost basis, overall ROI. */
function printOverallStats(result) {
    console.log(
        `── TOTAL REALISED P&L: ${formatSigned(result.totalRealisedPnL)} AUD | Cost Basis: ${result.totalCostBasis.toFixed(4)} | ROI: ${formatROI(result.overallROI)} ──\n`,
    );
}

/** Lists staking accruals (informational; not in FIFO P&L). */
function printStakingRewards(stakingRewards) {
    console.log('── STAKING REWARDS (excluded from P&L / ROI) ──\n');
    for (const [asset, amount] of Object.entries(stakingRewards)) {
        console.log(`  ${asset}: ${amount.toFixed(10)}`);
    }
    console.log();
}

/** Prints open FIFO lots (crypto still held after all ledger rows). */
function printRemainingHoldings(remainingHoldings) {
    console.log('── REMAINING HOLDINGS ──\n');
    for (const [asset, h] of Object.entries(remainingHoldings)) {
        console.log(
            `  ${asset}: ${h.totalAmount.toFixed(10)} (cost basis: ${h.totalCostBasis.toFixed(4)})`,
        );
    }
    console.log();
}

/**
 * Prints the exact stats object returned by the user profile API (`stats` in passport).
 * Re-fetches Balance, TradesHistory, and Ledgers via Kraken — same as production.
 *
 * @param {Object} stats - Return value of computeKrakenStats.
 */
function printProfileApiPayload(stats) {
    console.log(
        '\n══════════════════════════════════════════════════════════════',
    );
    console.log(
        '  USER API STATS (computeKrakenStats — passport / profile `stats`)',
    );
    console.log(
        '══════════════════════════════════════════════════════════════\n',
    );
    console.log(JSON.stringify(stats, null, 2));
    console.log();
}

/** Runs all print* sections in order for a calculateFIFOProfitLoss result. */
function printReport(result) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  FIFO PROFIT/LOSS REPORT');
    console.log('═══════════════════════════════════════════════════════════\n');

    printTradeBreakdown(result.trades);
    printAssetSummary(result.summary);
    printBestPerformer(result.bestPerformer);
    printOverallStats(result);
    printStakingRewards(result.stakingRewards);
    printRemainingHoldings(result.remainingHoldings);
}

// ─── Script entry: DB user → Ledgers → report ─────────────────────────

/**
 * Connects to MongoDB, loads the user’s Kraken REST key, paginates Ledgers, runs the FIFO
 * report, then disconnects.
 */
async function main() {
    if (!emailArg) {
        usage();
        process.exitCode = 1;
        return;
    }

    if (!config.DB_URL) {
        throw new Error('DB_URL missing. Please set it in env/.env');
    }

    await mongoose.connect(config.DB_URL);

    const user = await User.findOne({
        sEmail: emailArg,
        isDeleted: { $ne: true },
    })
        .select(
            'sEmail sKrakenApiKey sKrakenApiSecret sKrakenAccessToken sKrakenRefreshToken bIsKrakenConnected',
        )
        .lean();

    if (!user) throw new Error(`User not found: ${emailArg}`);
    if (!user.bIsKrakenConnected)
        throw new Error('User has not connected Kraken yet.');
    if (!user.sKrakenApiKey || !user.sKrakenApiSecret) {
        throw new Error('Missing sKrakenApiKey / sKrakenApiSecret on user.');
    }

    const apiFn = createCcxtApiFn(user.sKrakenApiKey, user.sKrakenApiSecret);

    /**
     * Fetch every ledger row from Kraken Ledgers (max 50 per request).
     */
    async function fetchAllLedgers(currentApiFn, baseParams) {
        const PAGE_SIZE = 50;
        const allLedger = {};
        let ofs = 0;
        let reportedTotal = null;

        for (;;) {
            const params = { ...baseParams, ofs: String(ofs) };
            console.log(`  Fetching Ledgers ofs=${ofs}…`);
            const page = await currentApiFn('Ledgers', params);
            const entries = page?.ledger || {};
            const batchKeys = Object.keys(entries);

            if (reportedTotal === null && page?.count != null && page.count !== '') {
                reportedTotal = Number(page.count);
                console.log(
                    `  Kraken reports total matching ledgers: ${reportedTotal}`,
                );
            }

            if (batchKeys.length === 0) break;

            Object.assign(allLedger, entries);

            if (batchKeys.length < PAGE_SIZE) break;
            if (
                reportedTotal != null &&
                Object.keys(allLedger).length >= reportedTotal
            ) {
                break;
            }

            ofs += batchKeys.length;
        }

        const fetched = Object.keys(allLedger).length;
        return {
            ledger: allLedger,
            count: reportedTotal ?? fetched,
        };
    }

    console.log('\n=== Kraken Debug Start ===');
    console.log('user:', user.sEmail);
    console.log('connected:', user.bIsKrakenConnected);

    let currentApiFn = apiFn;
    let ledgers;

    try {
        ledgers = await fetchAllLedgers(currentApiFn, { type: 'all' });
    } catch (err) {
        const isInvalidKey =
            String(err.message).includes('EAPI:Invalid key') ||
            String(err).includes('EAPI:Invalid key') ||
            (err?.response?.data?.error || []).some((e) =>
                String(e).includes('EAPI:Invalid key'),
            );

        if (isInvalidKey && user.sKrakenRefreshToken) {
            console.log('\n[!] Invalid Key detected. Attempting OAuth refresh and key re-minting...');
            try {
                const tokens = 
                await refreshKrakenToken(user.sKrakenRefreshToken);
                console.log('    Token refreshed.');

                await deleteAllTinkaFastApiKeys(tokens.access_token);
                const fastKey = await getFastApiKey(tokens.access_token);
                console.log('    New Fast API Key minted.');

                // Update DB so production also benefits
                await User.updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            sKrakenApiKey: fastKey.apiKey,
                            sKrakenApiSecret: fastKey.apiSecret,
                            sKrakenAccessToken: tokens.access_token,
                            sKrakenRefreshToken: tokens.refresh_token,
                            dKrakenTokenUpdatedAt: new Date(),
                        },
                    },
                );

                user.sKrakenApiKey = fastKey.apiKey;
                user.sKrakenApiSecret = fastKey.apiSecret;
                user.sKrakenAccessToken = tokens.access_token;
                user.sKrakenRefreshToken = tokens.refresh_token;

                currentApiFn = 
                createCcxtApiFn(user.sKrakenApiKey, user.sKrakenApiSecret);
                console.log('    Retrying ledger fetch with new key...\n');
                ledgers = await fetchAllLedgers(currentApiFn, { type: 'all' });
            } catch (refreshErr) {
                console.error('    Recovery failed:', refreshErr?.message || refreshErr);
                throw err; // throw original EAPI:Invalid key
            }
        } else {
            throw err;
        }
    }
    console.log(`Fetched ${Object.keys(ledgers.ledger || {}).length} / ${ledgers.count} ledger entries.`);

    printCompleteLedgerData(ledgers.ledger);

    const coverage = summarizeLedgerCoverage(ledgers.ledger);
    console.log('\n── Raw ledger coverage (verify assets like HBAR exist in API data) ──');
    console.log('Rows by type:', coverage.byType);
    console.log(
        `Rows with empty refid: ${coverage.rowsWithMissingRefid} (these cannot form spend+receive pairs in parseTrades)`,
    );
    console.log('Rows by asset (Kraken `asset` field):');
    const assetsSorted = Object.keys(coverage.byAsset).sort();
    for (const sym of assetsSorted) {
        console.log(`  ${sym}: ${coverage.byAsset[sym]}`);
    }
    const hbarKeys = assetsSorted.filter(
        (k) => /hbar/i.test(k) || /hedera/i.test(k),
    );
    if (hbarKeys.length === 0) {
        console.log(
            '\n  No ledger row uses an asset code matching "HBAR" (case-insensitive).',
        );
        console.log(
            '  If you expect Hedera exposure: confirm the code Kraken uses (often `HBAR`) and that this key can read Ledgers.',
        );
    } else {
        console.log('\n  HBAR-related asset codes in ledger:', hbarKeys.join(', '));
    }

    if (process.env.KRAKEN_DEBUG_LEDGER_PAIRS !== '0') {
        printAllLedgerPairs(ledgers.ledger);
    }

    const result = calculateFIFOProfitLoss(ledgers || {});

    printStablecoinRoiAnalysis(ledgers.ledger, result);

    printReport(result);

    let profileStats;   
    try {
        profileStats = await computeKrakenStats(currentApiFn, {
            bearerToken: user.sKrakenAccessToken || undefined,
        });
        printProfileApiPayload(profileStats);
        if (profileStats?.roi != null) {
            console.log(
                '── Production passport ROI (ledger + TradesHistory merged) ──\n' +
                `   roi: ${profileStats.roi} | winRate: ${profileStats.winRate}% | ` +
                `totalPairs: ${profileStats.totalPairs} | bestAsset: ${profileStats.bestAsset}\n` +
                '   If TradesHistory has USDT/USDC spot pairs, they share FIFO pools with ledger USDT legs (quote maps to USDT, not ZUSD).\n',
            );
        }
    } catch (apiStatsErr) {
        console.error(
            '\n── USER API STATS (computeKrakenStats) FAILED ──\n',
            apiStatsErr?.message || apiStatsErr,
        );
        if (apiStatsErr?.response?.data) {
            console.error(
                'Kraken response:',
                JSON.stringify(apiStatsErr.response.data, null, 2),
            );
        }
    }

    console.log('=== Kraken Debug End ===\n');
}

main()
    .catch((err) => {
        console.error('\nScript failed:', err?.message || err);
        if (err?.response?.data) {
            console.error(
                'Kraken response:',
                JSON.stringify(err.response.data, null, 2),
            );
        }
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await mongoose.disconnect();
        } catch {
            // ignore disconnect errors
        }
    });

// Re-export helpers so tests can import from this script without reaching into lib/.
module.exports = {
    calculateFIFOProfitLoss,
    summarizeLedgerCoverage,
    printAllLedgerPairs,
    printCompleteLedgerData,
    printStablecoinRoiAnalysis,
    groupByRefId,
    addFeeInAmount,
    passThroughLedgerAmounts,
    createApplyLedgerAmountsForFifo,
    calcROI,
    formatROI,
    runFIFO,
};