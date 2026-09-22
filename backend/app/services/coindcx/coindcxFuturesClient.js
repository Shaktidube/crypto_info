const API_BASE = 'https://api.coindcx.com';
const PUBLIC_BASE = 'https://public.coindcx.com';
const { resolveTimeframe } = require('./timeframes');

function normalizeRestCandle(row, durationMs = 60 * 1000) {
    const openTime = Number(row.time);
    return {
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        quoteVolume: row.quote_volume == null ? null : Number(row.quote_volume),
        openTime,
        closeTime: openTime + durationMs - 1,
        closed: true,
    };
}

async function getActiveInstruments(marginCurrency = 'USDT') {
    const axios = require('axios');
    const response = await axios.get(
        `${API_BASE}/exchange/v1/derivatives/futures/data/active_instruments`,
        {
            params: { 'margin_currency_short_name[]': marginCurrency },
            timeout: 15000,
        },
    );
    if (!Array.isArray(response.data)) {
        throw new Error('Unexpected CoinDCX active instruments response');
    }
    return response.data.filter((pair) => typeof pair === 'string');
}

async function getCandlesticks(pair, from, to, resolutionOrTimeframe = '1') {
    const axios = require('axios');
    let resolution = resolutionOrTimeframe;
    let durationMs = 60 * 1000;
    try {
        // Allow passing '1m' | '4h' | '1d' as well as raw API resolution.
        const tf = resolveTimeframe(resolutionOrTimeframe);
        resolution = tf.resolution;
        durationMs = tf.durationMs;
    } catch (_error) {
        if (resolutionOrTimeframe === '1D' || resolutionOrTimeframe === '1d') {
            durationMs = 24 * 60 * 60 * 1000;
            resolution = '1D';
        } else if (resolutionOrTimeframe === '240' ||
            resolutionOrTimeframe === '4h') {
            durationMs = 4 * 60 * 60 * 1000;
            resolution = resolutionOrTimeframe === '4h' ? '240' : '240';
        } else if (/^\d+$/.test(String(resolutionOrTimeframe))) {
            durationMs = Number(resolutionOrTimeframe) * 60 * 1000;
        }
    }

    const response = await axios.get(`${PUBLIC_BASE}/market_data/candlesticks`, {
        params: { pair, from, to, resolution, pcode: 'f' },
        timeout: 15000,
    });
    if (response.data?.s !== 'ok' || !Array.isArray(response.data.data)) {
        throw new Error(`Unexpected CoinDCX futures candles response for ${pair}`);
    }
    return response.data.data
        .map((row) => normalizeRestCandle(row, durationMs))
        .filter((candle) => [
            candle.open, candle.high, candle.low, candle.close,
            candle.volume, candle.openTime,
        ].every(Number.isFinite))
        .sort((a, b) => a.openTime - b.openTime);
}

module.exports = {
    getActiveInstruments,
    getCandlesticks,
    normalizeRestCandle,
};
