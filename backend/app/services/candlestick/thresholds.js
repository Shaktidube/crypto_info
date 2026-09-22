/**
 * Central thresholds for candlestick geometry and context.
 * Qualitative book language (e.g. "small body", "long wick") is mapped here
 * and marked as implementation assumptions where Rhoads does not give numbers.
 */
function defaultThresholds() {
    return {
        // Doji: open≈close. ASSUMPTION — book says equal; crypto needs tolerance.
        dojiMaxBodyToRange: 0.10,

        // Long candle vs recent average range. ASSUMPTION.
        longBodyMinPercent: 0.55,
        longRelativeToAvgRange: 1.20,
        relativeSizeLookback: 14,

        // Marubozu: book allows open=low and/or close=high.
        // ASSUMPTION — tiny wick allowance for tick noise.
        marubozuMaxWickToRange: 0.05,

        // Spinning top (Ch.6): both wicks ≥ body; body near center.
        spinningTopMaxBodyToRange: 0.30,
        spinningTopMinWickToBody: 1.0,
        spinningTopMaxBodyCenterOffset: 0.25,

        // Hammer / hanging man (Ch.6): small body at top + long lower wick.
        // ASSUMPTION — lower wick ≥ 2× body; upper wick small.
        hammerMaxBodyToRange: 0.35,
        hammerMinLowerWickToBody: 2.0,
        hammerMaxUpperWickToBody: 0.5,
        hammerMaxUpperWickToRange: 0.15,

        // Belt hold (Ch.6): open at extreme, close near opposite extreme.
        beltHoldMaxOpenWickToRange: 0.02,
        beltHoldMinBodyToRange: 0.60,

        // Engulfing (Ch.7/8): body and range of signal cover setup.
        engulfingRequireRangeCover: true,

        // Harami (Ch.7/8): inner body inside outer body.
        haramiMaxInnerBodyRatio: 0.50,
        haramiBodyTolerancePercent: 0.05,
        // Legacy scanner quality filters (project-specific, not from book).
        haramiMinImpulseBodyPercent: 0.55,
        haramiMinAtrMultiplier: 0.60,
        haramiMinVolumeMultiplier: 1.20,
        haramiInnerBodyPercentMin: 0.15,
        haramiInnerBodyPercentMax: 0.70,
        haramiRequireConfirmation: true,

        // Piercing / dark cloud: close through midpoint of setup body.
        piercingMinCloseThroughMidpoint: true,
        // ASSUMPTION — setup/signal should be relatively long.
        piercingMinBodyPercent: 0.40,

        // Meeting lines: closes nearly equal. ASSUMPTION.
        meetingLineMaxCloseDiffToRange: 0.05,

        // Stars (Ch.9/10): middle day small / near-doji with gap.
        starMaxMiddleBodyToRange: 0.30,
        starRequireGap: true,
        // ASSUMPTION — third day recovers a meaningful portion of first body.
        starMinThirdRecoveryOfFirstBody: 0.50,

        // Three white soldiers / black crows: progressive OHLC.
        soldiersMinBodyPercent: 0.40,

        // Trend context (SMA slope / price vs SMA). ASSUMPTION.
        trendSmaPeriod: 20,
        trendMinSlopePercent: 0.001,

        // Scoring weights (engineering model — not book certainty).
        score: {
            patternQuality: 0.40,
            context: 0.30,
            confirmation: 0.20,
            volume: 0.10,
        },

        // Indicator confirmation (optional; modular).
        rsiPeriod: 14,
        rsiOversold: 30,
        rsiOverbought: 70,
        volumeSmaPeriod: 20,
        atrPeriod: 14,
    };
}

function mergeThresholds(overrides = {}) {
    const base = defaultThresholds();
    return {
        ...base,
        ...overrides,
        score: { ...base.score, ...(overrides.score || {}) },
    };
}

module.exports = { defaultThresholds, mergeThresholds };
