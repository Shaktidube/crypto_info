# CoinDCX Futures 1-minute candle scanner

The scanner watches closed CoinDCX USDT futures candles for configurable
candlestick patterns and sends a deduplicated SMTP email.
It never places orders and never consumes spot candles.

Default timeframe is **1d** (book-aligned). Supported values:
`COINDCX_SCANNER_TIMEFRAME=1d|4h|1m`.

## Auto trading

Optional CoinDCX futures order placement after a high-quality signal:

```env
AUTO_TRADE_ENABLED=true
AUTO_TRADE_DRY_RUN=true   # keep true until you verify payloads
```

Live orders require **both**:
`AUTO_TRADE_ENABLED=true` and `AUTO_TRADE_DRY_RUN=false`.

Orders use the trade plan (market entry + stop_loss_price + take_profit_price + leverage).
Execution status is stored on each alert as `oTradeExecution`.

| Timeframe | Default cron (UTC) | When signals fire |
|-----------|--------------------|-------------------|
| `1d` | `5 0 0 * * *` | After each daily candle closes (~00:00:05 UTC) |
| `4h` | `5 0 0,4,8,12,16,20 * * *` | After each 4h candle closes |
| `1m` | `5 * * * * *` | After each 1m candle closes |

Leave `COINDCX_CRON_SCHEDULE` empty to use the timeframe default.

By default it uses the layered analysis engine with premium multi-candle
patterns. Set `CANDLE_USE_ANALYSIS_ENGINE=false` only when temporarily
reproducing the legacy volume/ATR-confirmed **Bearish Harami** behavior.

## Candlestick analysis layer

The modular engine under `app/services/candlestick` implements:

`OHLCV → CandleMetrics → PatternDetectors → MarketContext → Confirmation → SignalScorer`

Pattern geometry is evaluated separately from trend context and optional
indicator confirmation. Prior trend is measured only on candles before the
pattern and requires agreement from price/SMA, fast/slow SMA alignment, slope,
ATR-normalized movement, directional efficiency, and market structure. RSI,
Stochastic %K, ATR, and volume then provide independent confirmation.
A detected pattern is treated as **evidence**, not a trade instruction
(`tradeAction: 'none'`).

Enable with:

```sh
CANDLE_USE_ANALYSIS_ENGINE=true
CANDLE_ENABLED_PATTERNS=Bearish Harami,Evening Star,Three Inside Down
CANDLE_REQUIRE_CONTEXT_MATCH=true
CANDLE_REQUIRE_PRICE_CONFIRMATION=true
CANDLE_MIN_CONFIDENCE=0.55
```

With price confirmation enabled, two-candle patterns are emitted only after
the next closed candle breaks the pattern high/low in the expected direction.
This deliberately trades earlier entry for fewer false positives. Three-candle
patterns are already price-confirmed by their formation rules.

`nConfidence` is an evidence score, not a measured win probability. Calibrate
thresholds separately for each timeframe using walk-forward historical data;
do not compare a 1-minute configuration directly with 4-hour or daily results.

Thresholds for qualitative book language (doji size, hammer wick ratios, etc.)
live in `app/services/candlestick/thresholds.js` and are overridable via the
`thresholds` option on `analyzeCandles`.

## Setup

Copy the CoinDCX and candle settings from `.env.example` into `.env`. Set
`COINDCX_SCANNER_ENABLED=true`, configure `CANDLE_ALERT_EMAIL_TO`, and provide
working SMTP settings. `COINDCX_FUTURES_PAIRS` is an optional comma-separated
allowlist such as `B-BTC_USDT,B-ETH_USDT`; leaving it empty scans all active
USDT futures instruments.

Install dependencies and start the backend:

```sh
npm install
npm start
```

## Admin endpoints

All endpoints require an admin bearer token:

- `GET /api/v1/admin/coindcx/scanner/status`
- `POST /api/v1/admin/coindcx/scanner/start`
- `POST /api/v1/admin/coindcx/scanner/stop`
- `POST /api/v1/admin/coindcx/scanner/scan-now`
- `POST /api/v1/admin/coindcx/scanner/test-email`
- `GET /api/v1/admin/coindcx/alerts/list?nPage=1&nLimit=20`
- `GET /api/v1/admin/coindcx/signals/latest?nLimit=20&nMinConfidence=0.35&sDirection=bearish&sPair=B-BTC_USDT`

`signals/latest` returns a compact view with `nConfidence`, `oInvalidation`,
`sDirection`, context trend, and scanner detection settings.

The service seeds indicators with the futures REST API, then runs the configured
cron schedule. The default `5 * * * * *` runs at second 5 of every minute, after
the previous 1-minute candle has closed. Each run fetches only a short lookback
window, processes unseen closed candles in order, and limits concurrent API
requests. Overlapping runs are skipped. Alert keys are uniquely persisted in
MongoDB, preventing repeat emails after restarts.
