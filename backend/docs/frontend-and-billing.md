# React frontend, Google OTP login, and Stripe access

The Vite application lives in `frontend/` and uses the existing Express API.
The authentication flow is:

1. Google Identity Services returns an ID-token credential to the browser.
2. The backend verifies its signature, issuer, expiry, and configured audience.
3. The backend emails a six-digit OTP to the verified Google email.
4. Successful OTP verification creates the application JWT session.

Users may also begin directly with their email address. Both paths require the
same OTP verification before the protected dashboard is available.

## Local configuration

Copy the examples and fill in real development credentials:

```sh
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Use the same Google web client ID in both files:

```env
# backend/.env
GOOGLE_CLIENT_ID=123.apps.googleusercontent.com
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
FRONTEND_URL=http://localhost:3001

# frontend/.env
VITE_GOOGLE_CLIENT_ID=123.apps.googleusercontent.com
VITE_API_URL=/api/v1
```

In Google Cloud, configure `http://localhost:3001` as an authorized JavaScript
origin for the web OAuth client. Add the production HTTPS origin separately.
Never place a Stripe secret or webhook secret in `frontend/.env`.

## Run locally

Use two terminals:

```sh
npm run dev:backend
npm run dev:frontend
```

The frontend runs on `http://localhost:3001` and proxies `/api` to the backend
on port `4040`.

## Stripe webhook

The plans are one-time prepaid access periods, not automatic renewals:

- `monthly`: ₹199 for one month
- `quarterly`: ₹599 for three months
- `annual`: ₹999 for one year

For local Stripe testing, forward signed events to the raw-body endpoint:

```sh
stripe listen --forward-to localhost:4040/api/v1/billing/webhook
```

Copy the printed `whsec_...` value to `STRIPE_WEBHOOK_SECRET`. In production,
create the same HTTPS webhook endpoint in Stripe and listen for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

Access is activated by the signed webhook. The success page also asks the
backend to retrieve the Checkout Session, providing a server-verified fallback
when the webhook and redirect arrive in a different order.

## Production checklist

- Use HTTPS for the frontend, API, Google origin, and Stripe webhook.
- Restrict CORS to the production frontend origin.
- Store all backend secrets in the deployment secret manager.
- Keep Stripe in test mode until checkout and webhook events pass end-to-end.
- Configure working SMTP credentials and verify sender reputation.
- Keep CoinDCX auto trading in dry-run while validating signal behavior.
