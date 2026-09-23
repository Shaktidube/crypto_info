# Signal accuracy report

Generated on 23 September 2026 using the current production-style signal
configuration in `.env`.

## Result

| Pair | Candles | Signals | Wins | Losses | Unresolved | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC/USDT | 20,160 | 62 | 25 | 36 | 1 | 40.98% |
| ETH/USDT | 20,160 | 58 | 30 | 27 | 1 | 52.63% |
| SOL/USDT | 20,160 | 54 | 17 | 37 | 0 | 31.48% |
| XRP/USDT | 20,160 | 66 | 31 | 34 | 1 | 47.69% |
| **Aggregate** | **80,640** | **240** | **103** | **134** | **3** | **43.46%** |

Accuracy is `wins / (wins + losses)`. A win means the configured TP1 at 1.5R
was reached before the structural stop within the next 30 one-minute candles.
The resolution rate was 98.75%. No same-candle target/stop cases occurred; if
one occurs, it is reported as ambiguous instead of inventing intrabar order.

At 1.5R reward for 1R risk, the resolved sample has a gross expectancy of
approximately +0.087R per signal before fees, slippage and funding. That is not
a promise of future performance, and costs can remove this small edge.

## Methodology

- Market: CoinDCX public futures candles.
- Period: signals from 9 September through 23 September 2026 UTC.
- Timeframe: 1 minute.
- Pairs: BTC/USDT, ETH/USDT, SOL/USDT and XRP/USDT.
- Warm-up: 120 candles at every decision point.
- Look-ahead: disabled. Detection receives only candles already closed at the
  signal time. Future candles are used solely to score the outcome.
- Filters: previous-trend agreement, enabled premium patterns, closed-candle
  price confirmation, minimum confidence 0.55 and minimum confirmation 0.33.
- Outcome horizon: 30 future candles.

The machine-readable record, including every scored trade, is in
`reports/signal-backtest.json`.

## Reproduce

```sh
npm run backtest:signals -- --timeframe 1m --days 14 \
  --pairs B-BTC_USDT,B-ETH_USDT,B-SOL_USDT,B-XRP_USDT --horizon 30
```

## Interpretation

This test does not support advertising a high win rate. The current 1-minute
configuration produced a 43.46% TP1-before-stop rate. ETH was strongest and SOL
was weakest, but selecting markets after viewing this sample would introduce
selection bias. Any parameter or market change should be chosen on a training
period and verified on a later, untouched out-of-sample period before release.
