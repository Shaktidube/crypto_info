import http from 'node:http';

const plans = [
    { id: 'monthly', name: '1 Month', amountInr: 199, description: '30 days of access' },
    { id: 'quarterly', name: '3 Months', amountInr: 599, description: '90 days of access' },
    { id: 'annual', name: '1 Year', amountInr: 999, description: '365 days of access' },
];

const signal = {
    sId: 'signal-e2e-1',
    sSymbol: 'BTC/USDT',
    sTimeframe: '1m',
    sPatternName: 'Bullish Engulfing',
    sDirection: 'bullish',
    nConfidence: 0.78,
    bIsConfirmed: true,
    dSignalCandleCloseTime: new Date().toISOString(),
    oContext: { trend: 'downtrend' },
    oTradePlan: {
        entryPrice: 64250,
        stopLoss: 63790,
        takeProfit1: 64940,
        takeProfit2: 65400,
    },
};

function send(response, status, data) {
    response.writeHead(status, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Origin': 'http://127.0.0.1:3001',
        'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ message: 'OK', data }));
}

const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') return send(response, 204, {});
    const url = new URL(request.url, 'http://127.0.0.1:4041');

    if (url.pathname === '/api/v1/auth/user/send-otp') {
        return send(response, 200, { bOtpSent: true });
    }
    if (url.pathname === '/api/v1/auth/user/verify-otp') {
        return send(response, 200, {
            sToken: 'e2e-jwt-token',
            oUser: { sEmail: 'qa@example.com' },
        });
    }
    if (url.pathname === '/api/v1/auth/user/logout') {
        return send(response, 200, { bLoggedOut: true });
    }
    if (url.pathname === '/api/v1/billing/plans') {
        return send(response, 200, { aPlans: plans });
    }
    if (url.pathname === '/api/v1/user/dashboard') {
        return send(response, 200, {
            oUser: { sEmail: 'qa@example.com', sUsername: 'QA Trader' },
            oSubscription: {
                active: true,
                planId: 'annual',
                expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
            },
            oCurrentSignal: signal,
            aSignals: [signal],
        });
    }
    if (url.pathname === '/api/v1/billing/checkout-session') {
        return send(response, 200, {
            sCheckoutUrl: 'http://127.0.0.1:3001/payment/success?session_id=cs_e2e_paid',
        });
    }
    if (url.pathname === '/api/v1/billing/checkout-session/cs_e2e_paid') {
        return send(response, 200, {
            sPaymentStatus: 'paid',
            oSubscription: { active: true },
        });
    }
    return send(response, 404, {});
});

server.listen(4041, '127.0.0.1');
