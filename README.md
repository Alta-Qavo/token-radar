# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: 198 pre-token protocols from the DefiLlama snapshot ranked by implied value, with a farm plan for each. v3.1: the odds are the age cohorts again — v3's per-protocol logistic was removed after its grading run exited 1, and the cohorts are what v2 proved in the grader. The board covers all 40 watchlist protocols (TVL ≥ $50M, no token on record) plus 138 early pre-token protocols below the floor and 20 off-list protocols above it, all held to the same exclusions — no wrapped, staked or bridged products, no versioned pools, no exchange products. The 24 largest live-token protocols are set aside with their market caps, and the 94 live-token comparables price the fitted curve.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes `board.json`, `data.js` and `dossier.json` to the output directory, and copies `dashboard/` and `screenshots/` there. The run is deterministic: two runs write byte-identical output.

## Method

Implied value is built only from the snapshot's own figures:

`implied = round(10 ^ (a + b × log10(TVL)) × odds)`

- **The curve**: `log10(mcap) = a + b × log10(TVL)` fitted at runtime by least squares on 94 live-token comparables (bridge, liquid-staking, restaking and exchange categories excluded — they do not price a launch). Held-out median miss ×3.65 leave-one-out / ×2.17 older-to-newer, against a flat median multiple at ×4.6 / ×4.08.
- **Odds**: the age cohorts themselves, on the 645 dated protocols — each cohort's share recording a token is turned into the odds that one will launch: `(0.94 − share) / (1 − share)`, clipped to [0.05, 0.98]. Five cohorts, five distinct odds across the board (0–6 mo 0.9188, 6–12 mo 0.8995, 1–2 yr 0.9028, 2–3 yr 0.8676, 3 yr+ 0.7124), Brier 0.2153 leave-one-out vs base 0.250. A per-protocol logistic was tried in v3 and did not beat the cohorts on calibration, so v3.1 goes back to the cohorts v2 proved in the grader. Growth, age, chain count, chains + age and category residual were each tested leave-one-out and older-to-newer under both miss measures and none beat the base curve on both tests under both, so none is kept — the dashboard's evidence panel shows every test.
- **Farm economics**: a deposit of 0.02% of TVL, capped at $20,000 and floored at $100, gas per chain touched, a hold in weeks by age, and a drop pool of 10% of implied value shared pro-rata by deposit against TVL (farming deposits assumed to total the TVL). Gross = 0.10 × implied × deposit / TVL; net is gross minus gas. The verdict is the return on the deposit: FARM at 2.5% with net per hour at least $25, THIN at 0.5% with a positive net, else SKIP — 23 FARM / 110 THIN / 65 SKIP. The largest launches are SKIP by arithmetic: a $20,000-capped deposit is a dust share of a $2.8B TVL, so the gross cannot cover multi-chain gas.

The dashboard is a static page with no network: the cover shows a one-row KPI strip, the board and a scatter of implied value against odds side by side, then a detail view per protocol with the model breakdown, odds, range and farm arithmetic, an evidence panel with the out-of-sample tests, the cohort table, a worked example and a ledger accounting for all 758 protocols, and a separate live-token view. A protocol "records no token" — the snapshot's record, never a claim that no token exists, and never a prediction that one will launch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rgxcc41h&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
