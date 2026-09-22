/**
 * Shared helpers for Kraken ledger parsing, optional fee-adjusted amounts, and FIFO
 * processing. Used by the profile stats module (krakenStats.js) and the CLI debug script
 * (scripts/kraken-stats-debug.js).
 */

/** Remaining FIFO exposure below this AUD value is treated as closed (ledger rounding dust). */
const OPEN_POSITION_DUST_AUD = 0.01;

/**
 * Closed FIFO lot slices with proceeds below this AUD value are excluded from closed
 * counts, wins, win rate, ROI, and best-asset metrics (dust / rounding / dust sells).
 */
const CLOSED_LOT_MIN_PROCEEDS_AUD = 0.10;

const FIAT_COST_ASSETS_AUD = new Set(['ZAUD', 'AUD']);

/** USD-pegged quotes treated as 1:1 USD when converting sell proceeds → AUD. */
const USD_PEGGED_PROCEEDS_ASSETS = new Set([
    'ZUSD', 'USD', 'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE',
    'ZUSDT', 'ZUSDC',
]);

/**
 * Converts profit/loss and cost basis into a percentage return.
 *
 * @param {number} profitLoss - Gain or loss in the same currency as cost basis.
 * @param {number} costBasis - Total money at risk (denominator). If zero, ROI is undefined.
 * @returns {number|null} Percentage (e.g. 10.5 means +10.5%), or null if cost basis is 0.
 */
function calcROI(profitLoss, costBasis) {
    if (costBasis === 0) return null;
    return (profitLoss / costBasis) * 100;
}

/**
 * Turns a numeric ROI into a short human-readable string for logs or reports.
 *
 * @param {number|null|undefined} roi - Value from calcROI, or null/undefined when unknown.
 * @returns {string} Signed percentage with two decimals, or a message when cost basis was 0.
 */
function formatROI(roi) {
    if (roi === null || roi === undefined) return '∞ (no cost basis)';
    const sign = roi >= 0 ? '+' : '';
    return `${sign}${roi.toFixed(2)}%`;
}

// ─── Grouping and summarising ledger rows ─────────────────────────────────────

/**
 * Groups ledger entries that share the same Kraken `refid` (one booking often has a
 * spend leg and a receive leg under one refid).
 *
 * @param {Object<string, Object>} ledger - Map of ledger row id → row (Kraken API shape).
 * @returns {Object<string, Array>} Map of refid → list of rows; each row includes `ledgerId`.
 */
function groupByRefId(ledger) {
    const refGroups = {};
    for (const [ledgerId, entry] of Object.entries(ledger || {})) {
        const ref = entry.refid;
        if (!refGroups[ref]) refGroups[ref] = [];
        refGroups[ref].push({ ...entry, ledgerId });
    }
    return refGroups;
}

/**
 * Builds quick counts over a merged ledger object: how many rows per asset, per type,
 * and how many rows are missing `refid` (those cannot be paired for swap parsing).
 *
 * @param {Object<string, Object>} ledgerObj - Same shape as Kraken `result.ledger`.
 * @returns {{ byAsset: Object, byType: Object, totalRows: number, rowsWithMissingRefid: number }}
 */
function summarizeLedgerCoverage(ledgerObj) {
    const byAsset = {};
    const byType = {};
    let missingRefid = 0;
    for (const entry of Object.values(ledgerObj || {})) {
        const a = entry.asset || '(no asset)';
        byAsset[a] = (byAsset[a] || 0) + 1;
        const t = entry.type || '(no type)';
        byType[t] = (byType[t] || 0) + 1;
        if (entry.refid == null || entry.refid === '') missingRefid += 1;
    }
    return {
        byAsset,
        byType,
        totalRows: Object.keys(ledgerObj || {}).length,
        rowsWithMissingRefid: missingRefid,
    };
}

// ─── Adjusting spend/receive amounts before FIFO ─────────────────────────────
//
// Toggle in app code only (no environment variables). In krakenStats.js and
// kraken-stats-debug.js, keep one active line and comment the other:
//   createApplyLedgerAmountsForFifo(true)  → merge row fees into amounts (addFeeInAmount)
//   createApplyLedgerAmountsForFifo(false) → use Kraken gross amounts only (default)

/**
 * Increases the sold leg by its fee and decreases the bought leg by its fee so FIFO
 * uses “economic” amounts after fees. Use when you want net receive / full spend.
 *
 * @param {Object} trade - Must include soldAmount, boughtAmount, soldFee, boughtFee.
 * @returns {Object} Copy of the trade with adjusted soldAmount and boughtAmount.
 */
function addFeeInAmount(trade) {
    const sf = Math.abs(Number(trade.soldFee || 0));
    const bf = Math.abs(Number(trade.boughtFee || 0));
    return {
        ...trade,
        soldAmount: trade.soldAmount + sf,
        boughtAmount: trade.boughtAmount - bf,
    };
}

/**
 * Leaves amounts unchanged: only Kraken’s `amount` fields are used; row `fee` is ignored
 * for this step. This is the usual default for gross-notional matching.
 *
 * @param {Object} trade - Ledger-style trade object.
 * @returns {Object} Shallow copy of the trade.
 */
function passThroughLedgerAmounts(trade) {
    return { ...trade };
}

/**
 * Folds fees into purchase legs only (AUD/stable → crypto): spend + fee, receive − fee.
 * Sell legs keep gross crypto qty and gross fiat proceeds — matches Kraken CSV FIFO exports.
 *
 * @param {Object} trade - Ledger-style trade object.
 * @returns {Object} Shaped trade.
 */
function addFeeOnBuyOnlyAmount(trade) {
    const sf = Math.abs(Number(trade.soldFee || 0));
    const bf = Math.abs(Number(trade.boughtFee || 0));
    const soldFiat = KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(trade.soldAsset);
    const recvFiat = KRAKEN_LEDGER_FIFO_FIAT_ASSETS.includes(trade.boughtAsset);
    const isStableBuy =
        isFiatOnlyFifoLeg(trade.soldAsset) && 
        isStablecoinFifoLeg(trade.boughtAsset);
    if ((soldFiat && !recvFiat) || isStableBuy) {
        return {
            ...trade,
            soldAmount: trade.soldAmount + sf,
            boughtAmount: trade.boughtAmount - bf,
        };
    }
    return passThroughLedgerAmounts(trade);
}

/**
 * Builds the function that will be applied to each parsed ledger trade before FIFO.
 * The returned function has a `.mode` property so callers can log which strategy is on.
 *
 * @param {boolean|'buyOnly'} includeFees - true = addFeeInAmount; 'buyOnly' = purchase legs
 *   only; false = passThroughLedgerAmounts.
 * @returns {function(Object): Object} (trade) => shaped trade, with `.mode` set for logging.
 */
function createApplyLedgerAmountsForFifo(includeFees) {
    function applyLedgerAmountsForFifoBound(trade) {
        if (includeFees === 'buyOnly') return addFeeOnBuyOnlyAmount(trade);
        return includeFees
            ? addFeeInAmount(trade)
            : passThroughLedgerAmounts(trade);
    }
    let mode = 'passThroughLedgerAmounts';
    if (includeFees === true) mode = 'addFeeInAmount';
    if (includeFees === 'buyOnly') mode = 'addFeeOnBuyOnlyAmount';
    applyLedgerAmountsForFifoBound.mode = mode;
    return applyLedgerAmountsForFifoBound;
}

/**
 * Applies fee shaping once without storing a bound function. Prefer the factory above
 * when the same rule applies to many trades.
 *
 * @param {Object} trade - Ledger-style trade.
 * @param {{ includeFees?: boolean }} [options] - Pass `{ includeFees: true }` to fold fees.
 * @returns {Object} Shaped trade.
 */
function applyLedgerAmountsForFifo(trade, options = {}) {
    const includeFees = options.includeFees === true;
    return includeFees
        ? addFeeInAmount(trade)
        : passThroughLedgerAmounts(trade);
}

// ─── FIFO queue engine (ledger-shaped trades) ─────────────────────────────────

/**
 * Kraken internal / ledger asset codes treated as the “fiat or stable” leg for FIFO routing.
 * Must include stablecoins (USDT, USDC, …): ledger refid swaps attach raw codes on fifo*
 * rows, and parseLedgerSwapsFromLedgers only merges those swaps — if USDT is missing here,
 * USDT↔crypto legs fall through to processSwap and never become realised sells (win rate / pairs drop).
 *
 * @type {readonly string[]}
 */
const KRAKEN_LEDGER_FIFO_FIAT_ASSETS = [
    'ZAUD', 'ZUSD', 'ZEUR', 'ZGBP', 'ZCAD', 'ZJPY',
    // Kraken CSV / UI export symbols (Ledgers API often uses Z-prefixed codes)
    'AUD', 'USD', 'EUR', 'GBP', 'CAD', 'JPY',
    // Stablecoins (Kraken ledgers / fifo rows often use these verbatim, not Z-prefixed)
    'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE',
    // Alternate Kraken encodings seen in some ledgers
    'ZUSDT', 'ZUSDC',
];

/** Stablecoins held as assets (AUD round trips) — subset of KRAKEN_LEDGER_FIFO_FIAT_ASSETS. */
const KRAKEN_LEDGER_STABLECOIN_ASSETS = [
    'USDT', 'USDC', 'USDS', 'DAI', 'TUSD', 'PYUSD', 'USDE', 'ZUSDT', 'ZUSDC',
];

/** Fiat only (not stablecoins) — used for AUD↔USDT/USDC/USDS round-trip routing. */
const KRAKEN_LEDGER_FIAT_ONLY_ASSETS = [
    'ZAUD', 'ZUSD', 'ZEUR', 'ZGBP', 'ZCAD', 'ZJPY',
    'AUD', 'USD', 'EUR', 'GBP', 'CAD', 'JPY',
];

function isStablecoinFifoLeg(asset) {
    return KRAKEN_LEDGER_STABLECOIN_ASSETS.includes(String(asset || ''));
}

function isFiatOnlyFifoLeg(asset) {
    return KRAKEN_LEDGER_FIAT_ONLY_ASSETS.includes(String(asset || ''));
}

/**
 * Records a purchase: spend fiat (sold*) and receive crypto (bought*). Pushes one lot onto
 * the FIFO queue for the crypto asset with cost-per-unit derived from the fiat spent.
 *
 * @param {Object<string, Array>} fifoQueues - Per-asset queues of open lots (mutated).
 * @param {Object} trade - Fields: boughtAsset, boughtAmount, soldAmount, soldAsset, date, refid.
 */
function processBuy(fifoQueues, trade) {
    const asset = trade.boughtAsset;
    const amount = trade.boughtAmount;
    const totalCost = trade.soldAmount;
    const costPerUnit = totalCost / amount;

    if (!fifoQueues[asset]) fifoQueues[asset] = [];
    fifoQueues[asset].push({
        amount,
        costPerUnit,
        costAsset: trade.soldAsset,
        date: trade.date,
        refid: trade.refid,
    });
}

/**
 * Records a sale: spend crypto from the oldest lots first (FIFO) and receive fiat.
 * Returns one result object with proceeds, matched cost basis, profit, and ROI for that sell.
 *
 * @param {Object<string, Array>} fifoQueues - Per-asset queues (mutated).
 * @param {Object} trade - Fields: soldAsset, soldAmount (crypto), boughtAmount (fiat proceeds).
 * @returns {Object} Realised P&L row (proceeds, costBasis, profitLoss, roi, lotsUsed, …).
 */
function processSell(fifoQueues, trade) {
    const asset = trade.soldAsset;
    const sellAmount = trade.soldAmount;
    const totalProceeds = trade.boughtAmount;

    if (!fifoQueues[asset]) fifoQueues[asset] = [];

    let remaining = sellAmount;
    let totalCostBasis = 0;
    const lotsUsed = [];

    while (remaining > 0 && fifoQueues[asset].length > 0) {
        const oldestLot = fifoQueues[asset][0];

        if (oldestLot.amount <= remaining) {
            totalCostBasis += oldestLot.amount * oldestLot.costPerUnit;
            lotsUsed.push({
                amount: oldestLot.amount,
                costPerUnit: oldestLot.costPerUnit,
                date: oldestLot.date,
            });
            remaining -= oldestLot.amount;
            fifoQueues[asset].shift();
        } else {
            totalCostBasis += remaining * oldestLot.costPerUnit;
            lotsUsed.push({
                amount: remaining,
                costPerUnit: oldestLot.costPerUnit,
                date: oldestLot.date,
            });
            oldestLot.amount -= remaining;
            remaining = 0;
        }
    }

    if (remaining > 0) {
        lotsUsed.push({
            amount: remaining,
            costPerUnit: 0,
            date: 'unknown (no matching buy)',
        });
    }

    const profit = totalProceeds - totalCostBasis;
    const roi = calcROI(profit, totalCostBasis);

    return {
        date: trade.date,
        refid: trade.refid,
        asset,
        soldAmount: sellAmount,
        proceeds: totalProceeds,
        costBasis: totalCostBasis,
        profitLoss: profit,
        roi,
        fiatCurrency: trade.boughtAsset,
        lotsUsed,
    };
}

/**
 * Records a crypto-to-crypto move: dequeues sold asset FIFO lots and transfers their
 * cost basis onto the received asset (same economic lot, new symbol).
 *
 * @param {Object<string, Array>} fifoQueues - Per-asset queues (mutated).
 * @param {Object} trade - Fields: soldAsset, soldAmount, boughtAsset, boughtAmount, date, refid.
 */
function processSwap(fifoQueues, trade) {
    const soldAsset = trade.soldAsset;
    const sellAmount = trade.soldAmount;
    const boughtAsset = trade.boughtAsset;
    const boughtAmount = trade.boughtAmount;

    if (!fifoQueues[soldAsset]) fifoQueues[soldAsset] = [];

    let remaining = sellAmount;
    let totalCostBasis = 0;
    let costAsset = soldAsset;

    while (remaining > 1e-12 && fifoQueues[soldAsset].length > 0) {
        const oldestLot = fifoQueues[soldAsset][0];

        if (oldestLot.amount <= remaining + 1e-12) {
            totalCostBasis += oldestLot.amount * oldestLot.costPerUnit;
            if (oldestLot.costAsset) costAsset = oldestLot.costAsset;
            remaining -= oldestLot.amount;
            fifoQueues[soldAsset].shift();
        } else {
            totalCostBasis += remaining * oldestLot.costPerUnit;
            if (oldestLot.costAsset) costAsset = oldestLot.costAsset;
            oldestLot.amount -= remaining;
            remaining = 0;
        }
    }

    const costPerUnit = 
    boughtAmount > 1e-12 ? totalCostBasis / boughtAmount : 0;

    if (!fifoQueues[boughtAsset]) fifoQueues[boughtAsset] = [];
    fifoQueues[boughtAsset].push({
        amount: boughtAmount,
        costPerUnit,
        costAsset,
        date: trade.date,
        refid: trade.refid,
        note: remaining > 1e-12
            ? `Swap from ${sellAmount} ${soldAsset} (${remaining.toFixed(8)} unmatched)`
            : `Swap from ${sellAmount} ${soldAsset}`,
    });
}

/**
 * Walks a time-ordered list of ledger-style trades and updates FIFO queues. Dispatches each
 * row to processBuy, processSell, or processSwap based on whether the sold/bought asset is
 * in the fiat list.
 *
 * @param {Array<Object>} trades - Oldest first; each item has sold*, bought*, date, refid.
 * @param {{ fiatAssets?: string[] }} [options] - Override fiat list; default is
 *   KRAKEN_LEDGER_FIFO_FIAT_ASSETS.
 * @returns {{ realisedPnL: Array<Object>, fifoQueues: Object<string, Array> }}
 *   realisedPnL = one entry per sell; fifoQueues = remaining open lots per asset.
 */
function runFIFO(trades, options = {}) {
    const fiatAssets = options.fiatAssets || KRAKEN_LEDGER_FIFO_FIAT_ASSETS;
    const fifoQueues = {};
    const realisedPnL = [];

    for (const trade of trades) {
        const soldFiat = fiatAssets.includes(trade.soldAsset);
        const boughtFiat = fiatAssets.includes(trade.boughtAsset);

        if (soldFiat && !boughtFiat) {
            // Fiat/stable spent → crypto received (e.g. AUD→SOL, USDT→ETH)
            processBuy(fifoQueues, trade);
        } else if (!soldFiat && boughtFiat) {
            // Crypto spent → fiat/stable received (e.g. SOL→AUD, ETH→USDT)
            realisedPnL.push(processSell(fifoQueues, trade));
        } else if (soldFiat && boughtFiat) {
            // Fiat↔stable round trips (e.g. AUD→USDT buy, USDT→AUD sell)
            if (isFiatOnlyFifoLeg(trade.soldAsset) && 
            isStablecoinFifoLeg(trade.boughtAsset)) {
                processBuy(fifoQueues, trade);
            } else if (isStablecoinFifoLeg(trade.soldAsset) && 
            isFiatOnlyFifoLeg(trade.boughtAsset)) {
                realisedPnL.push(processSell(fifoQueues, trade));
            }
            // stable↔stable or fiat↔fiat: skip (not a crypto or stable round trip)
        } else {
            processSwap(fifoQueues, trade);
        }
    }

    return { realisedPnL, fifoQueues };
}

/**
 * Estimates total AUD value of an open FIFO queue (per asset).
 * Prefers AUD book cost; falls back to market marks when available.
 *
 * @param {string} asset - FIFO queue key (Kraken asset code).
 * @param {Array<Object>} lots - Open lots for the asset.
 * @param {Object} assetInfo - `{ [ccy]: { price, balance, usdValue } }` from portfolio marks.
 * @param {function(string): string} [normalizeAsset] - Maps Kraken codes to ticker symbols.
 * @returns {number}
 */
function estimateFifoQueueValueAud(asset, lots, assetInfo, normalizeAsset) {
    if (!Array.isArray(lots) || !lots.length) return 0;

    const amount = lots.reduce((s, l) => s + Number(l.amount || 0), 0);
    if (amount <= 1e-12) return 0;

    const bookAud = lots.reduce((s, l) => {
        const costAsset = String(l.costAsset || '');
        if (FIAT_COST_ASSETS_AUD.has(costAsset)) {
            return s + Number(l.amount || 0) * Number(l.costPerUnit || 0);
        }
        return s;
    }, 0);
    if (bookAud > 0) return bookAud;

    const norm = typeof normalizeAsset === 'function' ? normalizeAsset(asset) : asset;
    const mark = assetInfo?.[norm];
    const priceUsd = Number(mark?.price ?? 0);
    const audUsd = Number(assetInfo?.AUD?.price ?? 0);
    if (priceUsd > 0 && audUsd > 0) {
        return (amount * priceUsd) / audUsd;
    }

    return lots.reduce(
        (s, l) => s + Number(l.amount || 0) * Number(l.costPerUnit || 0),
        0,
    );
}

/**
 * Removes FIFO queues whose total remaining value is below the dust threshold.
 * Mutates `fifoQueues` in place so open-position counts ignore ledger rounding residue.
 *
 * @param {Object<string, Array>} fifoQueues
 * @param {Object} assetInfo
 * @param {{ dustAud?: number, normalizeAsset?: function(string): string }} [options]
 * @returns {number} Queues removed as dust.
 */
function pruneFifoDustQueues(fifoQueues, assetInfo, options = {}) {
    const dustAud = options.dustAud ?? OPEN_POSITION_DUST_AUD;
    const normalizeAsset = options.normalizeAsset;
    let removed = 0;

    for (const asset of Object.keys(fifoQueues || {})) {
        const lots = fifoQueues[asset];
        if (!Array.isArray(lots) || !lots.length) {
            delete fifoQueues[asset];
            continue;
        }
        const valueAud = estimateFifoQueueValueAud(
            asset,
            lots,
            assetInfo,
            normalizeAsset,
        );
        if (valueAud < dustAud) {
            delete fifoQueues[asset];
            removed += 1;
        }
    }

    return removed;
}

/**
 * Counts open FIFO lot entries after dust pruning (caller should prune first).
 *
 * @param {Object<string, Array>} fifoQueues
 * @returns {number}
 */
function countOpenFifoLots(fifoQueues) {
    if (!fifoQueues || typeof fifoQueues !== 'object') return 0;
    let n = 0;
    for (const lots of Object.values(fifoQueues)) {
        if (!Array.isArray(lots)) continue;
        for (const lot of lots) {
            const amt = Number(lot?.amount ?? 0);
            if (amt > 1e-12) n += 1;
        }
    }
    return n;
}

/**
 * @param {Object} lot - FIFO lot slice from processSell lotsUsed.
 * @returns {boolean}
 */
function isValidClosedFifoLot(lot) {
    return Boolean(
        lot &&
        lot.costPerUnit > 0 &&
        lot.date !== 'unknown (no matching buy)',
    );
}

/**
 * Converts a fiat/stable proceeds amount into AUD using portfolio FX marks.
 * AUD legs stay as-is; USD pegs use AUDUSD; other fiat uses assetInfo USD price.
 *
 * @param {number} amount
 * @param {string} fiatCurrency - Sell settlement asset (e.g. ZAUD, USDT).
 * @param {Object} [assetInfo]
 * @returns {number}
 */
function fiatAmountToAud(amount, fiatCurrency, assetInfo) {
    const n = Number(amount || 0);
    if (!Number.isFinite(n) || n === 0) return 0;

    const code = String(fiatCurrency || '').trim().toUpperCase();
    if (FIAT_COST_ASSETS_AUD.has(code)) return n;

    const audUsd = Number(assetInfo?.AUD?.price ?? 0);
    if (USD_PEGGED_PROCEEDS_ASSETS.has(code)) {
        return audUsd > 0 ? n / audUsd : n;
    }

    const norm = code.replace(/^Z/, '');
    const usdPerUnit = Number(
        assetInfo?.[norm]?.price ?? assetInfo?.[code]?.price ?? 0,
    );
    if (usdPerUnit > 0 && audUsd > 0) return (n * usdPerUnit) / audUsd;
    if (audUsd > 0) return n / audUsd;
    return n;
}

/**
 * Valid matched FIFO lot slices on a sell whose allocated proceeds meet the AUD floor.
 * Unmatched leftovers (`unknown (no matching buy)`) are never included.
 *
 * Lot proceeds = (lot.amount / sell.soldAmount) × sell.proceeds.
 * Lot P&L = lotProceeds − (lot.amount × lot.costPerUnit).
 *
 * @param {Object} row - runFIFO sell row.
 * @param {{ assetInfo?: Object, minProceedsAud?: number }} [options]
 * @returns {Array<{ lot: Object, amount: number, proceeds: number, proceedsAud: number, cost: number, pnl: number }>}
 */
function iterQualifyingClosedLots(row, options = {}) {
    const assetInfo = options.assetInfo || {};
    const minProceedsAud = options.minProceedsAud ?? CLOSED_LOT_MIN_PROCEEDS_AUD;
    const sold = Number(row?.soldAmount || 0);
    const sellProceeds = Number(row?.proceeds || 0);
    const out = [];

    for (const lot of row?.lotsUsed || []) {
        if (!isValidClosedFifoLot(lot)) continue;
        const amount = Number(lot.amount || 0);
        if (amount <= 1e-12) continue;
        const share = sold > 1e-12 ? amount / sold : 0;
        const proceeds = sellProceeds * share;
        const proceedsAud = fiatAmountToAud(
            proceeds,
            row.fiatCurrency,
            assetInfo,
        );
        if (proceedsAud < minProceedsAud) continue;
        const cost = amount * Number(lot.costPerUnit || 0);
        out.push({
            lot,
            amount,
            proceeds,
            proceedsAud,
            cost,
            pnl: proceeds - cost,
        });
    }
    return out;
}

/**
 * @param {Object} trade - runFIFO input row.
 * @param {string[]} [fiatAssets]
 * @returns {boolean}
 */
function isFifoBuyLeg(trade, fiatAssets = KRAKEN_LEDGER_FIFO_FIAT_ASSETS) {
    const soldFiat = fiatAssets.includes(trade.soldAsset);
    const boughtFiat = fiatAssets.includes(trade.boughtAsset);
    if (soldFiat && !boughtFiat) return true;
    return (
        isFiatOnlyFifoLeg(trade.soldAsset) &&
        isStablecoinFifoLeg(trade.boughtAsset)
    );
}

/**
 * Counts FIFO purchase legs (ledger buys + stable funding buys).
 *
 * @param {Array<Object>} trades - runFIFO input rows.
 * @param {{ fiatAssets?: string[] }} [options]
 * @returns {number}
 */
function countFifoBuyLegs(trades, options = {}) {
    const fiatAssets = options.fiatAssets || KRAKEN_LEDGER_FIFO_FIAT_ASSETS;
    return (trades || []).filter(t => isFifoBuyLeg(t, fiatAssets)).length;
}

/**
 * Counts each qualifying FIFO lot consumption on a sell as one closed trade (partial
 * lot matches across sells each count separately). Unmatched leftovers are ignored.
 * Lots with allocated proceeds below CLOSED_LOT_MIN_PROCEEDS_AUD are ignored.
 *
 * @param {Array<Object>} realisedPnL - Rows from runFIFO.
 * @param {{
 *   excludeFirstDayStableFunding?: boolean,
 *   firstTradingDayKey?: string|null,
 *   assetInfo?: Object,
 *   minProceedsAud?: number,
 * }} [options]
 * @returns {number}
 */
function countClosedFifoLotRecords(realisedPnL, options = {}) {
    const excludeFirstDayStable = options.excludeFirstDayStableFunding === true;
    const firstDayKey = options.firstTradingDayKey || null;
    let n = 0;
    for (const row of realisedPnL || []) {
        const sellDay = String(row.date || '').slice(0, 10);
        const skipStableFunding = excludeFirstDayStable &&
            firstDayKey &&
            sellDay === firstDayKey &&
            isStablecoinFifoLeg(row.asset);
        if (skipStableFunding) continue;
        n += iterQualifyingClosedLots(row, options).length;
    }
    return n;
}

/**
 * Counts qualifying closed lots with positive allocated P&L (proceeds − cost).
 *
 * @param {Array<Object>} realisedPnL - Rows from runFIFO.
 * @param {{ assetInfo?: Object, minProceedsAud?: number }} [options]
 * @returns {number}
 */
function countFifoLotLevelWins(realisedPnL, options = {}) {
    let wins = 0;
    for (const row of realisedPnL || []) {
        for (const q of iterQualifyingClosedLots(row, options)) {
            if (q.pnl > 0) wins += 1;
        }
    }
    return wins;
}

/**
 * Rolls qualifying closed lots into totals for ROI / best-asset (excludes leftovers
 * and sub-AUD-floor lots).
 *
 * @param {Array<Object>} realisedPnL
 * @param {{ assetInfo?: Object, minProceedsAud?: number }} [options]
 * @returns {{
 *   totalProfitLoss: number,
 *   totalCostBasis: number,
 *   totalProceeds: number,
 *   closedLots: number,
 *   wins: number,
 *   byAsset: Object<string, {
 *     asset: string,
 *     totalProceeds: number,
 *     totalCostBasis: number,
 *     totalProfitLoss: number,
 *     tradeCount: number,
 *     roi: number|null,
 *   }>,
 * }}
 */
function summarizeQualifyingClosedLots(realisedPnL, options = {}) {
    const byAsset = {};
    let totalProfitLoss = 0;
    let totalCostBasis = 0;
    let totalProceeds = 0;
    let closedLots = 0;
    let wins = 0;

    for (const row of realisedPnL || []) {
        for (const q of iterQualifyingClosedLots(row, options)) {
            closedLots += 1;
            if (q.pnl > 0) wins += 1;
            totalProfitLoss += q.pnl;
            totalCostBasis += q.cost;
            totalProceeds += q.proceeds;

            const a = row.asset;
            if (!byAsset[a]) {
                byAsset[a] = {
                    asset: a,
                    totalProceeds: 0,
                    totalCostBasis: 0,
                    totalProfitLoss: 0,
                    tradeCount: 0,
                };
            }
            byAsset[a].totalProceeds += q.proceeds;
            byAsset[a].totalCostBasis += q.cost;
            byAsset[a].totalProfitLoss += q.pnl;
            byAsset[a].tradeCount += 1;
        }
    }

    for (const s of Object.values(byAsset)) {
        s.roi = calcROI(s.totalProfitLoss, s.totalCostBasis);
    }

    return {
        totalProfitLoss,
        totalCostBasis,
        totalProceeds,
        closedLots,
        wins,
        byAsset,
    };
}

/**
 * Win rate to one decimal place (e.g. 18.8 for 9 wins / 48 buys).
 *
 * @param {number} wins
 * @param {number} denominator - Typically FIFO buy-leg count.
 * @returns {number}
 */
function calcWinRatePct(wins, denominator) {
    if (!denominator || denominator <= 0) return 0;
    return Math.round((wins / denominator) * 1000) / 10;
}

/**
 * Calendar day key (YYYY-MM-DD) for the earliest FIFO buy leg.
 *
 * @param {Array<Object>} fifoInputRows - runFIFO input rows (must include `time`).
 * @returns {string|null}
 */
function getFirstTradingDayKey(fifoInputRows) {
    const buys = (fifoInputRows || []).filter(r => isFifoBuyLeg(r));
    if (!buys.length) return null;
    const earliest = buys.reduce(
        (min, r) => (r.time < min.time ? r : min),
        buys[0],
    );
    return new Date(earliest.time * 1000).toISOString().slice(0, 10);
}

/**
 * Drops stable→fiat sell legs on the account's first trading day (funding hops).
 *
 * @param {Array<Object>} realisedPnL
 * @param {{ firstTradingDayKey?: string|null }} [options]
 * @returns {Array<Object>}
 */
function filterFirstDayStableFundingSells(realisedPnL, options = {}) {
    const firstDayKey = options.firstTradingDayKey;
    if (!firstDayKey) return realisedPnL || [];
    return (realisedPnL || []).filter((row) => {
        if (!isStablecoinFifoLeg(row.asset)) return true;
        return String(row.date || '').slice(0, 10) !== firstDayKey;
    });
}


module.exports = {
    calcROI,
    formatROI,
    groupByRefId,
    summarizeLedgerCoverage,
    addFeeInAmount,
    addFeeOnBuyOnlyAmount,
    passThroughLedgerAmounts,
    createApplyLedgerAmountsForFifo,
    isFifoBuyLeg,
    isValidClosedFifoLot,
    fiatAmountToAud,
    iterQualifyingClosedLots,
    countFifoBuyLegs,
    countClosedFifoLotRecords,
    countFifoLotLevelWins,
    summarizeQualifyingClosedLots,
    calcWinRatePct,
    getFirstTradingDayKey,
    filterFirstDayStableFundingSells,
    applyLedgerAmountsForFifo,
    KRAKEN_LEDGER_FIFO_FIAT_ASSETS,
    KRAKEN_LEDGER_STABLECOIN_ASSETS,
    KRAKEN_LEDGER_FIAT_ONLY_ASSETS,
    isStablecoinFifoLeg,
    isFiatOnlyFifoLeg,
    OPEN_POSITION_DUST_AUD,
    CLOSED_LOT_MIN_PROCEEDS_AUD,
    estimateFifoQueueValueAud,
    pruneFifoDustQueues,
    countOpenFifoLots,
    processBuy,
    processSell,
    processSwap,
    runFIFO,
};
