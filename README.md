# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Alta-Qavo/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: 178 pre-token protocols from the DefiLlama snapshot ranked by implied value, with a farm plan for each. The board covers all 40 watchlist protocols (TVL ≥ $50M, no token on record) plus 138 early pre-token protocols below the floor, held to the same exclusions — no wrapped, staked or bridged products, no versioned pools, no exchange products. The 24 largest live-token protocols are set aside with their market caps, and double as the valuation comparables.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes `board.json`, `data.js` and `dossier.json` to the output directory, and copies `dashboard/` and `screenshots/` there. The run is deterministic: two runs write byte-identical output.

## Method

Implied value is built only from the snapshot's own figures:

`implied = round(TVL × comp × growth × maturity)`

- **comp**: the category median of market-cap / TVL across live-token protocols (≥3 comparables), shrunk toward the global median (0.2138) with a prior weight of 3, clamped to [0.05, 0.80].
- **growth**: `1 + clamp(change_7d, -50, 100) / 100 × 0.4`.
- **maturity**: `0.7 + min(age_days, 1095) / 1095 × 0.3`, where age is the time since the protocol was first listed (365 days when unlisted).

The dashboard is a static page with no network: a sortable, searchable, filterable board, a detail view per protocol with the model breakdown, comparables, risks and a 6-step farm plan, and a separate live-token view. A protocol "records no token" — the snapshot's record, never a claim that no token exists, and never a prediction that one will launch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rgxcc41h&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
