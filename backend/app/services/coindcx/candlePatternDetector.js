/**
 * Compatibility facade for the CoinDCX scanner.
 * Prefer `app/services/candlestick` for new analysis code.
 */
const {
    candleMetrics,
    detectBearishHarami,
    analyzeCandles,
    analyzeForAlert,
} = require('../candlestick');

module.exports = {
    candleMetrics,
    detectBearishHarami,
    analyzeCandles,
    analyzeForAlert,
};
