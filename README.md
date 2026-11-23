# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: 198 pre-token protocols from the DefiLlama snapshot ranked by implied value, with a farm plan for each. The board covers all 40 watchlist protocols (TVL ≥ $50M, no token on record) plus 138 early pre-token protocols below the floor and 20 off-list protocols above it, all held to the same exclusions — no wrapped, staked or bridged products, no versioned pools, no exchange products. The 24 largest live-token protocols are set aside with their market caps, and the 94 live-token comparables price the fitted curve.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes `board.json`, `data.js` and `dossier.json` to the output directory, and copies `dashboard/` and `screenshots/` there. The run is deterministic: two runs write byte-identical output.

## Method

Implied value is built only from the snapshot's own figures:

`implied = round(10 ^ (a + b × log10(TVL)) × odds)`

- **The curve**: `log10(mcap) = a + b × log10(TVL)` fitted at runtime by least squares on 94 live-token comparables (bridge, liquid-staking, restaking and exchange categories excluded — they do not price a launch). Held-out median miss ×3.65 leave-one-out / ×2.17 older-to-newer, against a flat median multiple at ×4.6 / ×4.08.
- **odds**: `(0.94 − share) / (1 − share)`, where share is the fraction of protocols in the same age cohort that already record a token. Brier 0.215 against a base rate of 0.250. Growth, age, chain count and category residual were each tested leave-one-out and older-to-newer under both miss measures and none beat the base curve on both tests under both, so none is kept — the dashboard's evidence panel shows every test.
- **Farm economics**: a deposit sized by TVL tier, gas per chain touched, a hold in weeks by age, and a drop share of 0.00001 of implied value (10% of supply shared by 10,000 farmers). Net per hour decides the verdict: FARM at $50/h, THIN at $10/h, else SKIP.

The dashboard is a static page with no network: a sortable, searchable, filterable board, an evidence panel with the out-of-sample tests and the scatter of comparables against the fit, a detail view per protocol with the model breakdown, odds, range and farm economics, a ledger accounting for all 758 protocols, and a separate live-token view. A protocol "records no token" — the snapshot's record, never a claim that no token exists, and never a prediction that one will launch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rgxcc41h&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
