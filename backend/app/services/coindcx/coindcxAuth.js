const crypto = require('crypto');
const axios = require('axios');
const config = require('../../../config/config');

const API_BASE = 'https://api.coindcx.com';

function signBody(body, secret) {
    const payload = JSON.stringify(body);
    return {
        payload,
        signature: crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex'),
    };
}

function requireCredentials() {
    const key = String(config.COINDCX_API_KEY || '').trim();
    const secret = String(config.COINDCX_API_SECRET || '').trim();
    if (!key || !secret) {
        throw new Error('COINDCX_API_KEY and COINDCX_API_SECRET are required');
    }
    return { key, secret };
}

function summarizeExchangeError(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data.slice(0, 300);
    return String(
        data.message || data.error || data.code || JSON.stringify(data),
    ).slice(0, 300);
}

/**
 * POST signed JSON to CoinDCX. Body is stringified once and sent as-is
 * so the HMAC matches the wire payload.
 */
async function signedPost(path, body) {
    const { key, secret } = requireCredentials();
    const { payload, signature } = signBody(body, secret);
    const response = await axios.post(`${API_BASE}${path}`, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-AUTH-APIKEY': key,
            'X-AUTH-SIGNATURE': signature,
        },
        timeout: 20000,
        validateStatus: () => true,
        transformRequest: [(data) => data],
    });
    return {
        status: response.status,
        data: response.data,
        errorMessage: summarizeExchangeError(response.data),
    };
}

module.exports = {
    API_BASE,
    signBody,
    requireCredentials,
    summarizeExchangeError,
    signedPost,
};
