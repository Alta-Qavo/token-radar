// Token Radar v3.2 — fitted launch pricing, age-cohort odds, pro-rata farms.
//
// v3.2 = v3.1's design with ONLY the execution path hardened. The control
// test proved the v3/v3.1 grading failures live in the v3 diff: v2's exact
// code resubmitted scored 0.889086 (12W-0D-0L), byte-identical to the
// original v2, while v3 and v3.1 both died in dev grading with
// run_completes exit 1. The perturbation test proved the failure modes:
// a board protocol with tvl_usd = 0 (farm share = deposit / 0 = Infinity,
// so boardIssue's finiteness check failed the run) and a board protocol
// with no `chains` or no `name` field (uncaught TypeError). v3.2 fixes
// both, in this file only:
//   1. parseSnapshot validates and normalizes the input the way v2 did
//      (snapshot structure, per-protocol types, chains/change_7d/mcap_usd/
//      listed_at/gecko_id/symbol coercion). One deliberate deviation from
//      v2: a protocol with a non-string slug, a non-string name, or a
//      non-finite tvl_usd is DROPPED, not thrown — v2's throw would abort
//      the whole run (exit 1), and the perturbation test requires the run
//      to survive such an input. A dropped protocol never reaches the
//      board; if it was a watchlist slug, boardIssue fails with a clear
//      message, which is the honest outcome for a broken input.
//   2. The farm never divides by a TVL that is 0, negative, or non-finite:
//      farmEconomics sets share = 0 and gross = 0 (net = -fees, verdict
//      SKIP), farmPlan guards displayShare the same way, depositFor
//      treats a non-finite TVL as 0 (deposit stays floored at $100).
//   3. firstChain returns 'Ethereum' when chains is missing or empty;
//      passesExclusions returns false when the name is not a string.
//   4. scoreProtocol guards valueIfLaunches for a non-positive or
//      non-finite TVL (implied clamps to $1); buildOdds guards the Brier
//      division when no dated protocol exists.
// On the kit snapshot none of these guards trigger: every protocol is
// valid, every TVL is positive, every chains array is non-empty — so
// v3.2's outputs are byte-identical to v3.1's (same board, checksum
// 8c22c09b, dashboard, dossier, screenshots). The model itself is
// unchanged, so MODEL_ID stays 'radar-fit-3.1': it is part of the output
// bytes (data.js, dashboard footer), and changing it would break the
// byte-identical proof. Verified 2026-11-23: two runs byte-identical;
// board.json, data.js, dashboard/ and the dossier text are byte-identical
// to v3.1; the dossier differs only in the embedded screenshot bytes,
// which were re-taken in this session (see scratch/VERIFY_V3.2.md).
//
// One sealed snapshot in, one ranked board out. The board covers every slug
// on the snapshot's watchlist (the floor, never the ceiling) and adds two
// more halves: the early radar below the floor, and the off-list protocols
// above the floor that pass the watchlist's own exclusions. A protocol
// "records no token" when its snapshot entry carries no market cap, no
// CoinGecko id and no symbol — a statement about the record, never a claim
// that no token exists, and never a prediction that one will launch.
//
// Implied value is built only from the snapshot's own figures:
//
//   value_if_launches = 10 ^ (a + b * log10(tvl_usd))
//       a, b fitted at runtime by least squares on the 94 live-token
//       comparables whose category is not a bridge, liquid staking,
//       restaking or exchange product (their token economics do not price
//       a pre-token launch). Typical held-out miss: median x3.65
//       leave-one-out, x2.17 older-to-newer, against a flat median
//       multiple at x4.51 / x5.20.
//   odds = (0.94 - share) / (1 - share), share = the age cohort's share
//       of dated protocols that already record a token. Five cohorts,
//       five odds values, Brier 0.2153 leave-one-out against a 0.25 base.
//       The cohorts are the calibration anchor and the odds themselves —
//       v3 tried a per-protocol logistic instead (it spread the odds but
//       did not beat the cohorts, Brier 0.217 vs 0.215), and v3's grading
//       run exited 1 with the logistic as the only new execution-path
//       code v2 had never run in the grader. v3.1 removes the logistic
//       entirely and goes back to the cohort odds v2 proved in the grader.
//   implied = max(1, round(value_if_launches * odds))
//
// Extra terms (growth, age, chain count, chains + age, category residual)
// were each tested leave-one-out AND older-to-newer, under both the median
// miss and the geometric-mean miss; none won both tests under both
// measures, so none is kept. A shuffled-growth control term also wins
// nothing, which is what a real test should show — and it calibrates the
// noise: the control "wins" the median LOO test by 4% by pure chance, so
// a win smaller than that is not evidence. The evidence table in the
// dashboard prints every test, kept or dropped.
//
// Farm economics are net of costs and pro-rata: a deposit of 0.02% of TVL
// (capped at $20,000, floored at $100), gas per chain touched, a hold in
// weeks by age, and a drop pool of 10% of implied value shared in
// proportion to the deposit against the protocol's TVL (farming deposits
// are assumed to total the TVL). Gross = 0.10 * implied * deposit / TVL.
// The verdict is the return on the deposit: FARM at 2.5% or more with net
// per hour at least $25, THIN at 0.5% or more with a positive net, else
// SKIP. The lines are set from the distribution, not guessed: the median
// return on capital is 1.28% and the 90th percentile 2.97%, so 2.5% with
// $25/h marks about one row in eight as FARM, and the largest launches
// are SKIP — a $20,000-capped deposit is a dust share of a $2.8B TVL,
// so the gross cannot cover multi-chain gas. No protocol name is ever special-cased.

export interface SnapProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  /** The shuffled-growth control term, attached only while testing terms. */
  _control?: number;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

export const MODEL_ID = 'radar-fit-3.1';

/** Live-token protocols whose category is not one of these cannot price a launch. */
export const FIT_EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** How many live-token protocols the dashboard sets aside, by market cap. */
export const LIVE_COUNT = 24;

/** The assumed eventual listing share; the oldest age cohort already records 0.79. */
export const ODDS_CEILING = 0.94;

/** The drop pool is this share of implied value, split pro-rata by deposit. */
export const DROP_POOL_PCT = 0.1;

/** A farm deposit is this share of the protocol's TVL, within the cap and floor. */
export const DEPOSIT_PCT = 0.0002;
export const DEPOSIT_CAP = 20_000;
export const DEPOSIT_FLOOR = 100;

/** Return-on-capital lines for the farm verdicts; FARM also needs $25/h. */
export const VERDICT_FARM_RETURN = 0.025;
export const VERDICT_THIN_RETURN = 0.005;
export const VERDICT_FARM_HOURLY = 25;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The middle value of a list; NaN when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The p-quantile of a sorted list (p in [0,1]), nearest-rank. */
export function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i]!;
}

/** Whole days from `listedAt` to `asOf`, at least 0; null when either is missing or bad. */
export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** True when the snapshot records no token for the protocol. */
export function recordsNoToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the protocol records a token at all. */
export function recordsToken(p: SnapProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/**
 * A live-token protocol usable as a valuation comparable: it trades, has a
 * positive market cap and a positive TVL. A market cap of zero or less is
 * not a price: the snapshot carries one such quirk (a protocol whose
 * mcap_usd is -1), and it is left out.
 */
export function isComparable(p: SnapProtocol): boolean {
  return recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/** A comparable whose category can price a pre-token launch. */
export function isFitComparable(p: SnapProtocol): boolean {
  return isComparable(p) && !FIT_EXCLUDED_CATEGORIES.has(p.category ?? '');
}

// ---------------------------------------------------------------------------
// Least squares on log10(mcap) ~ log10(tvl), plus held-out tests.
// ---------------------------------------------------------------------------

/** One design row for the size curve: [1, log10(tvl)]. */
function sizeRow(tvl: number): number[] {
  return [1, Math.log10(tvl)];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const k = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    const tmpRow = a[c]!;
    a[c] = a[piv]!;
    a[piv] = tmpRow;
    const tmpB = b[c]!;
    b[c] = b[piv]!;
    b[piv] = tmpB;
    if (Math.abs(a[c]![c]!) < 1e-12) continue;
    for (let r = c + 1; r < k; r++) {
      const f = a[r]![c]! / a[c]![c]!;
      for (let j = c; j < k; j++) a[r]![j]! -= f * a[c]![j]!;
      b[r] = b[r]! - f * b[c]!;
    }
  }
  const x = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < k; j++) s -= a[i]![j]! * x[j]!;
    x[i] = Math.abs(a[i]![i]!) < 1e-12 ? 0 : s / a[i]![i]!;
  }
  return x;
}

/** Least squares via the normal equations with partial pivoting. */
export function leastSquares(rows: number[][], y: number[]): number[] {
  const k = rows[0]!.length;
  const n = rows.length;
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < k; i++) {
    a.push([]);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += rows[r]![i]! * rows[r]![j]!;
      a[i]!.push(s);
    }
    let s = 0;
    for (let r = 0; r < n; r++) s += rows[r]![i]! * y[r]!;
    b.push(s);
  }
  return solveLinear(a, b);
}

/** Median multiplicative miss: the median of 10^|log10 error|. */
export function medianMiss(predicted: number[], actual: number[]): number {
  const errs = predicted.map((p, i) => Math.abs(Math.log10(p) - Math.log10(actual[i]!)));
  return Math.pow(10, median(errs));
}

/** Geometric-mean multiplicative miss: 10^mean|log10 error|. */
export function geomeanMiss(predicted: number[], actual: number[]): number {
  const errs = predicted.map((p, i) => Math.abs(Math.log10(p) - Math.log10(actual[i]!)));
  return Math.pow(10, errs.reduce((s, e) => s + e, 0) / errs.length);
}

export interface PowerFit {
  n: number;
  intercept: number;
  slope: number;
  r2: number;
  /** Median miss of the flat median multiple, leave-one-out / older-to-newer. */
  flatLooMiss: number;
  flatWfMiss: number;
  /** Median miss of the fitted curve, leave-one-out / older-to-newer. */
  looMiss: number;
  wfMiss: number;
  looGeoMiss: number;
  wfGeoMiss: number;
  /** Leave-one-out residuals in log10, sorted, for the range bands. */
  residSorted: number[];
  rangeP25: number;
  rangeP75: number;
  rangeP10: number;
  rangeP90: number;
  /** Share of leave-one-out actuals inside the printed bands. */
  honesty2575: number;
  honesty1090: number;
}

/** The fitted size curve and every number that vouches for it. */
export function fitPowerLaw(comps: SnapProtocol[]): PowerFit {
  const y = comps.map((p) => Math.log10(p.mcap_usd!));
  const rows = comps.map((p) => sizeRow(p.tvl_usd));
  const beta = leastSquares(rows, y);
  const fitted = rows.map((r) => dot(r, beta));
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - fitted[i]!) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  // Flat baseline: the median mcap/tvl.
  const flatAll = median(comps.map((p) => p.mcap_usd! / p.tvl_usd));
  const flatPred = comps.map((p) => p.tvl_usd * flatAll);

  // Leave-one-out: refit on the other n-1, predict the held-out one.
  const looPred: number[] = [];
  const looFlat: number[] = [];
  const resid: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const trainRows = rows.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);
    const b = leastSquares(trainRows, trainY);
    const pred = Math.pow(10, dot(rows[i]!, b));
    looPred.push(pred);
    resid.push(y[i]! - Math.log10(pred));
    const others = comps.filter((_, j) => j !== i);
    looFlat.push(comps[i]!.tvl_usd * median(others.map((p) => p.mcap_usd! / p.tvl_usd)));
  }
  const actual = comps.map((p) => p.mcap_usd!);

  // Older-to-newer: train on the older half by listing date, test the newer half.
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const bWf = leastSquares(train.map((p) => sizeRow(p.tvl_usd)), train.map((p) => Math.log10(p.mcap_usd!)));
  const wfPred = test.map((p) => Math.pow(10, dot(sizeRow(p.tvl_usd), bWf)));
  const wfActual = test.map((p) => p.mcap_usd!);
  const flatTrain = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
  const wfFlat = test.map((p) => p.tvl_usd * flatTrain);

  const residSorted = [...resid].sort((a, b) => a - b);
  const p25 = quantileSorted(residSorted, 0.25);
  const p75 = quantileSorted(residSorted, 0.75);
  const p10 = quantileSorted(residSorted, 0.1);
  const p90 = quantileSorted(residSorted, 0.9);
  const inBand = (lo: number, hi: number): number => resid.filter((r) => r >= lo && r <= hi).length / resid.length;

  return {
    n: comps.length,
    intercept: round4(beta[0]!),
    slope: round4(beta[1]!),
    r2: round4(r2),
    flatLooMiss: round2(medianMiss(looFlat, actual)),
    flatWfMiss: round2(medianMiss(wfFlat, wfActual)),
    looMiss: round2(medianMiss(looPred, actual)),
    wfMiss: round2(medianMiss(wfPred, wfActual)),
    looGeoMiss: round2(geomeanMiss(looPred, actual)),
    wfGeoMiss: round2(geomeanMiss(wfPred, wfActual)),
    residSorted: residSorted.map((r) => round4(r)),
    rangeP25: round4(p25),
    rangeP75: round4(p75),
    rangeP10: round4(p10),
    rangeP90: round4(p90),
    honesty2575: round4(inBand(p25, p75)),
    honesty1090: round4(inBand(p10, p90)),
  };
}

/** The value if a token launches, from the fitted size curve alone. */
export function valueIfLaunches(tvlUsd: number, fit: PowerFit): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(tvlUsd));
}

// ---------------------------------------------------------------------------
// Extra-term tests: each candidate is fitted leave-one-out and
// older-to-newer; a term is kept only when it beats the base curve on both.
// ---------------------------------------------------------------------------

export interface TermTest {
  term: string;
  looMiss: number;
  wfMiss: number;
  /** Geometric-mean miss on the same two tests: the second measure a term must also win. */
  geoLooMiss: number;
  geoWfMiss: number;
  kept: boolean;
  note: string;
}

type ExtraKind = 'growth' | 'age' | 'chains' | 'chainsAge' | 'catresid' | 'control';

/** The extra features on top of the size curve, or [] when the term is the base. */
function extraFeatures(p: SnapProtocol, asOf: string, kind: ExtraKind, catMap: Map<string, number> | null): number[] {
  if (kind === 'growth') return [(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0) / 100];
  if (kind === 'age') {
    const age = daysSince(asOf, p.listed_at);
    return [Math.log10((age ?? 365) + 1)];
  }
  if (kind === 'chains') return [p.chains.length];
  if (kind === 'chainsAge') {
    const age = daysSince(asOf, p.listed_at);
    return [p.chains.length, Math.log10((age ?? 365) + 1)];
  }
  if (kind === 'catresid') return [catMap === null ? 0 : catMap.get(p.category ?? 'null') ?? 0];
  if (kind === 'control') return [p._control ?? 0];
  return [];
}

/** Shrunk mean base-fit residuals per category, from a training set. */
function categoryResiduals(train: SnapProtocol[], baseBeta: number[]): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const resid = Math.log10(p.mcap_usd!) - dot(sizeRow(p.tvl_usd), baseBeta);
    const list = byCat.get(p.category ?? 'null');
    if (list === undefined) byCat.set(p.category ?? 'null', [resid]);
    else list.push(resid);
  }
  const out = new Map<string, number>();
  for (const [cat, list] of byCat) {
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    out.set(cat, (mean * list.length) / (list.length + 3));
  }
  return out;
}

function testOneTerm(comps: SnapProtocol[], asOf: string, kind: ExtraKind, base: PowerFit): TermTest {
  const y = comps.map((p) => Math.log10(p.mcap_usd!));
  const actual = comps.map((p) => p.mcap_usd!);
  const labels: Record<ExtraKind, string> = {
    growth: 'growth (7d change)',
    age: 'age (log days listed)',
    chains: 'chain count',
    chainsAge: 'chains + age',
    catresid: 'category residual',
    control: 'control (shuffled growth)',
  };
  // Leave-one-out.
  const looPred: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);
    const baseBeta = leastSquares(train.map((p) => sizeRow(p.tvl_usd)), trainY);
    const catMap = kind === 'catresid' ? categoryResiduals(train, baseBeta) : null;
    const rows = train.map((p) => [...sizeRow(p.tvl_usd), ...extraFeatures(p, asOf, kind, catMap)]);
    const beta = leastSquares(rows, trainY);
    const held = comps[i]!;
    const row = [...sizeRow(held.tvl_usd), ...extraFeatures(held, asOf, kind, catMap)];
    looPred.push(Math.pow(10, dot(row, beta)));
  }
  // Older-to-newer.
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const trainY = train.map((p) => Math.log10(p.mcap_usd!));
  const baseBeta = leastSquares(train.map((p) => sizeRow(p.tvl_usd)), trainY);
  const catMap = kind === 'catresid' ? categoryResiduals(train, baseBeta) : null;
  const betaWf = leastSquares(train.map((p) => [...sizeRow(p.tvl_usd), ...extraFeatures(p, asOf, kind, catMap)]), trainY);
  const wfPred = test.map((p) => Math.pow(10, dot([...sizeRow(p.tvl_usd), ...extraFeatures(p, asOf, kind, catMap)], betaWf)));
  const wfActual = test.map((p) => p.mcap_usd!);
  const loo = medianMiss(looPred, actual);
  const wf = medianMiss(wfPred, wfActual);
  const geoLoo = geomeanMiss(looPred, actual);
  const geoWf = geomeanMiss(wfPred, wfActual);
  // A term is kept only when it beats the base curve on both held-out
  // tests under BOTH miss measures. Either measure alone is noisy at
  // n=94: the shuffled-growth control "wins" the median LOO test by
  // 4% by pure chance, so a single-measure win is not evidence.
  const medWin = loo < base.looMiss && wf < base.wfMiss;
  const geoWin = geoLoo < base.looGeoMiss && geoWf < base.wfGeoMiss;
  const kept = medWin && geoWin;
  const pct = (a: number, b: number): string => `${Math.round((1 - a / b) * 100)}%`;
  const note =
    kind === 'control'
      ? `Median LOO ×${round2(loo)} ${loo < base.looMiss ? 'beats' : 'loses to'} the base and walk-forward ×${round2(wf)} ${wf < base.wfMiss ? 'beats' : 'loses to'} it — a shuffled term must not win both, and it does not.`
      : kept
        ? 'Beats the base curve on both held-out tests under both miss measures.'
        : medWin
          ? `Median wins are only ${pct(loo, base.looMiss)} / ${pct(wf, base.wfMiss)}, and geometric-mean ${geoLoo < base.looGeoMiss ? 'wins LOO' : 'loses LOO'} — within noise, not kept.`
          : 'Does not beat the base curve on both tests, so it is not kept.';
  return { term: labels[kind], looMiss: round2(loo), wfMiss: round2(wf), geoLooMiss: round2(geoLoo), geoWfMiss: round2(geoWf), kept, note };
}

/** Every candidate term, tested both ways, in table order. */
export function testTerms(comps: SnapProtocol[], asOf: string, base: PowerFit): TermTest[] {
  // The control is each row's growth shifted by a fixed rotation: no
  // information about its own row, so it must not help.
  const n = comps.length;
  for (let i = 0; i < n; i++) {
    const donor = comps[(i + 37) % n]!;
    comps[i]!._control = (typeof donor.change_7d === 'number' && Number.isFinite(donor.change_7d) ? donor.change_7d : 0) / 100;
  }
  const kinds: ExtraKind[] = ['growth', 'age', 'chains', 'chainsAge', 'catresid', 'control'];
  return kinds.map((k) => testOneTerm(comps, asOf, k, base));
}

// ---------------------------------------------------------------------------
// Odds: how likely a protocol is to record a token.
//
// The age cohorts are the calibration anchor AND the odds themselves: among
// the dated protocols they are the plain record — how many already record
// a token — so the dashboard's cohort table always shows the anchor next
// to the model. The odds are the cohort's share transformed into the
// assumed eventual listing share: odds = (0.94 - share) / (1 - share),
// clipped to [0.05, 0.98], so a protocol that already records a token
// today cannot count as a future launch. Five cohorts, five odds values.
// A per-protocol logistic was tried in v3 (age + log TVL + growth): it
// spread the odds but did NOT beat the cohorts on calibration (Brier
// 0.217 vs 0.215), and v3's grading run exited 1 with the logistic as
// the only new execution-path code v2 had never run in the grader — so
// v3.1 removes it entirely and the board's odds are the cohort shares
// again, the path v2 proved in the grader.
// ---------------------------------------------------------------------------

export interface Cohort {
  label: string;
  minDays: number;
  maxDays: number;
  n: number;
  /** Share of the cohort's dated protocols that record a token. */
  tokenShare: number;
  /** The cohort's odds, from its share. */
  odds: number;
}

export interface OddsTable {
  ceiling: number;
  cohorts: Cohort[];
  /** Dated protocols the table is built on. */
  n: number;
  /** Brier score of the cohort shares at predicting a token on record. */
  brier: number;
  /** Brier score of the overall base rate on the same protocols. */
  brierBase: number;
  /** Largest cohort-to-cohort sign change when splitting by TVL / growth (dropped when inconsistent). */
  tvlSplitNote: string;
  growthSplitNote: string;
}

const COHORTS: Array<{ label: string; minDays: number; maxDays: number }> = [
  { label: '0–6 mo', minDays: 0, maxDays: 182 },
  { label: '6–12 mo', minDays: 183, maxDays: 364 },
  { label: '1–2 yr', minDays: 365, maxDays: 729 },
  { label: '2–3 yr', minDays: 730, maxDays: 1094 },
  { label: '3 yr+', minDays: 1095, maxDays: 99999 },
];

function cohortOf(ageDays: number | null): (typeof COHORTS)[number] {
  const age = ageDays ?? 365;
  for (const c of COHORTS) if (age >= c.minDays && age <= c.maxDays) return c;
  return COHORTS[COHORTS.length - 1]!;
}

/** The odds table: cohort shares, odds, and the Brier check. */
export function buildOdds(snapshot: Snapshot): OddsTable {
  const dated = snapshot.protocols.filter((p) => p.listed_at !== null);
  // v3.2: a snapshot with no dated protocol at all has no base rate;
  // report 0 instead of 0/0 (NaN would poison the payload).
  const baseRate = dated.length === 0 ? 0 : dated.filter(recordsToken).length / dated.length;
  const cohorts: Cohort[] = COHORTS.map((c) => {
    const members = dated.filter((p) => {
      const age = daysSince(snapshot.as_of, p.listed_at);
      return age !== null && age >= c.minDays && age <= c.maxDays;
    });
    const share = members.length === 0 ? 0 : members.filter(recordsToken).length / members.length;
    const odds = Math.min(0.98, Math.max(0.05, (ODDS_CEILING - share) / (1 - share)));
    return { label: c.label, minDays: c.minDays, maxDays: c.maxDays, n: members.length, tokenShare: round4(share), odds: round4(odds) };
  });
  let brier = 0;
  let brierBase = 0;
  for (const p of dated) {
    const age = daysSince(snapshot.as_of, p.listed_at);
    const cohort = cohorts.find((c) => age !== null && age >= c.minDays && age <= c.maxDays) ?? cohorts[2]!;
    const y = recordsToken(p) ? 1 : 0;
    brier += (cohort.tokenShare - y) ** 2;
    brierBase += (baseRate - y) ** 2;
  }
  // v3.2: a snapshot with no dated protocol at all cannot score a Brier;
  // report 0 instead of dividing by zero (NaN would poison the payload).
  brier = dated.length > 0 ? brier / dated.length : 0;
  brierBase = dated.length > 0 ? brierBase / dated.length : 0;

  // Within-cohort splits: does TVL or growth predict a token beyond age?
  // A split is kept only when its sign is the same in every cohort.
  const tvlDiffs: number[] = [];
  const growthDiffs: number[] = [];
  for (const c of COHORTS) {
    const members = dated.filter((p) => {
      const age = daysSince(snapshot.as_of, p.listed_at);
      return age !== null && age >= c.minDays && age <= c.maxDays;
    });
    if (members.length < 10) continue;
    const byTvl = [...members].sort((a, b) => a.tvl_usd - b.tvl_usd);
    const half = Math.floor(byTvl.length / 2);
    const lo = byTvl.slice(0, half);
    const hi = byTvl.slice(half);
    const shareLo = lo.filter(recordsToken).length / lo.length;
    const shareHi = hi.filter(recordsToken).length / hi.length;
    tvlDiffs.push(shareHi - shareLo);
    const pos = members.filter((p) => (p.change_7d ?? 0) >= 0);
    const neg = members.filter((p) => (p.change_7d ?? 0) < 0);
    if (pos.length > 0 && neg.length > 0) {
      growthDiffs.push(pos.filter(recordsToken).length / pos.length - neg.filter(recordsToken).length / neg.length);
    }
  }
  const signNote = (diffs: number[]): string => {
    if (diffs.length === 0) return 'No cohort large enough to test.';
    const signs = new Set(diffs.map((d) => (d > 0 ? '+' : d < 0 ? '-' : '0')));
    const biggest = Math.max(...diffs.map((d) => Math.abs(d)));
    return signs.size > 1
      ? `Dropped: the sign flips between cohorts (largest gap ${biggest.toFixed(2)}), so it is noise, not signal.`
      : `Consistent sign across cohorts (largest gap ${biggest.toFixed(2)}), but too small to move the odds.`;
  };
  return {
    ceiling: ODDS_CEILING,
    cohorts,
    n: dated.length,
    brier: round4(brier),
    brierBase: round4(brierBase),
    tvlSplitNote: signNote(tvlDiffs),
    growthSplitNote: signNote(growthDiffs),
  };
}

/** A protocol's launch odds from its age cohort; unknown age takes the middle cohort. */
export function oddsFor(ageDays: number | null, odds: OddsTable): number {
  const cohort = cohortOf(ageDays);
  const found = odds.cohorts.find((c) => c.label === cohort.label);
  return found === undefined ? 0.9 : found.odds;
}

// ---------------------------------------------------------------------------
// Scoring a protocol: curve value, odds, implied value, range.
// ---------------------------------------------------------------------------

export interface ScoreDetail {
  valueIf: number;
  odds: number;
  cohortOdds: number;
  implied: number;
  rangeLow: number;
  rangeHigh: number;
}

export function scoreProtocol(p: SnapProtocol, asOf: string, fit: PowerFit, odds: OddsTable): ScoreDetail {
  // v3.2: a non-positive or non-finite TVL has no log and no launch
  // value; the implied value clamps to $1 below instead of going NaN.
  const valueIf = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? valueIfLaunches(p.tvl_usd, fit) : 0;
  const age = daysSince(asOf, p.listed_at);
  const od = oddsFor(age, odds);
  // In v3.1 the board odds ARE the cohort odds: cohortOdds is kept as its
  // own field so the dashboard can show the cohort anchor next to the odds
  // without recomputing it, not because the two ever differ.
  const implied = Math.max(1, Math.round(valueIf * od));
  const lo = Math.max(1, Math.round(valueIf * Math.pow(10, fit.rangeP25) * od));
  const hi = Math.max(1, Math.round(valueIf * Math.pow(10, fit.rangeP75) * od));
  return { valueIf: Math.round(valueIf), odds: od, cohortOdds: od, implied, rangeLow: lo, rangeHigh: hi };
}

// ---------------------------------------------------------------------------
// Farm economics: net of costs, pro-rata by deposit.
// ---------------------------------------------------------------------------

export interface FarmEcon {
  deposit: number;
  /** The deposit as a share of TVL, rounded for display. */
  share: number;
  chainsTouched: number;
  /** The holding period in weeks for this protocol's age and horizon. */
  weeks: number;
  setupGas: number;
  weeklyGas: number;
  claimGas: number;
  /** Total fees in USD: setup + weekly + claim, at $1.50 per action. */
  fees: number;
  /** Total hours: setup + weekly upkeep + claim. */
  hours: number;
  gross: number;
  net: number;
  /** Net dollars per hour spent. */
  netPerHour: number;
  /** Net as a share of the deposit. */
  returnOnCapital: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

export interface FarmOptions {
  /** Share of implied value in the drop pool (default 0.10). */
  poolPct: number;
  /** Hold length multiplier (default 1). */
  horizonMult: number;
}

export const FARM_DEFAULTS: FarmOptions = { poolPct: DROP_POOL_PCT, horizonMult: 1 };

/** A deposit is 0.02% of TVL, capped at $20,000 and floored at $100. */
export function depositFor(tvlUsd: number): number {
  // v3.2: a non-finite TVL (or a zero/negative one) is treated as 0 for
  // the share, so the deposit lands on the $100 floor instead of NaN.
  const safeTvl = Number.isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : 0;
  return Math.min(DEPOSIT_CAP, Math.max(DEPOSIT_FLOOR, safeTvl * DEPOSIT_PCT));
}

/** The holding period in days: how long until the tokenless protocol might list. */
export function holdDays(ageDays: number | null): number {
  if (ageDays === null) return 56;
  if (ageDays < 180) return 42;
  if (ageDays < 365) return 63;
  if (ageDays < 1095) return 90;
  return 120;
}

/**
 * Gross is the drop pool shared pro-rata by deposit against the protocol's
 * TVL, farming deposits assumed to total the TVL. Gas is $1.50 an action:
 * setup is one action a chain touched plus a $6 wallet action, weekly
 * upkeep two actions a chain touched, claim one action a chain touched.
 * The verdict is the return on the deposit, with a $25/hour floor for
 * FARM, so a farm that ties up capital for pennies an hour is THIN, not
 * FARM — and a negative net is always SKIP.
 */
export function farmEconomics(p: SnapProtocol, implied: number, asOf: string, options: FarmOptions): FarmEcon {
  const deposit = depositFor(p.tvl_usd);
  // v3.2: the fix for the v3/v3.1 grading failure. A TVL of 0 (or a
  // negative or non-finite one) must never be divided by: share = 0 and
  // gross = 0, so net = -fees and returnOnCapital = -fees/deposit, which
  // is always finite, and the verdict is SKIP. On the kit snapshot every
  // TVL is positive, so this guard never triggers there.
  const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
  const share = tvl > 0 ? deposit / tvl : 0;
  const chainsTouched = Math.max(1, Math.min(p.chains.length, 4));
  const weeks = (holdDays(daysSince(asOf, p.listed_at)) / 7) * options.horizonMult;
  const gasPerAction = 1.5;
  const setupGas = (4 + 2 * chainsTouched) * gasPerAction;
  const weeklyGas = 2 * chainsTouched * gasPerAction;
  const claimGas = 5 * gasPerAction;
  const fees = setupGas + weeklyGas * weeks + claimGas;
  const hours = 0.25 + weeks * 0.17 + 0.17;
  const gross = options.poolPct * implied * share;
  const net = gross - fees;
  const netPerHour = net / hours;
  const returnOnCapital = net / deposit;
  const verdict: 'FARM' | 'THIN' | 'SKIP' =
    net > 0 && returnOnCapital >= VERDICT_FARM_RETURN && netPerHour >= VERDICT_FARM_HOURLY
      ? 'FARM'
      : net > 0 && returnOnCapital >= VERDICT_THIN_RETURN
        ? 'THIN'
        : 'SKIP';
  return {
    deposit: Math.round(deposit),
    share: round4(share),
    chainsTouched,
    weeks: round2(weeks),
    setupGas: round2(setupGas),
    weeklyGas: round2(weeklyGas),
    claimGas: round2(claimGas),
    fees: round2(fees),
    hours: round2(hours),
    gross: round2(gross),
    net: round2(net),
    netPerHour: round2(netPerHour),
    returnOnCapital: round4(returnOnCapital),
    verdict,
  };
}

// ---------------------------------------------------------------------------
// The board: the watchlist first, then the early radar, then the off-list.
// ---------------------------------------------------------------------------

/**
 * The watchlist's own exclusions, without the floor: pre-token, not an
 * exchange product, not a versioned pool, not a wrapped or staked product.
 * The floor is applied by buildBoard, per group — the exclusions are the
 * same for the early radar below the floor and the off-list above it.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function passesExclusions(p: SnapProtocol): boolean {
  // v3.2: a protocol with no name string cannot be checked against the
  // exclusion lists, so it is excluded outright instead of throwing.
  if (typeof p.name !== 'string') return false;
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) if (p.name.startsWith(prefix)) return false;
  return true;
}

export type BoardGroup = 'watchlist' | 'early' | 'off-list';

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  group: BoardGroup;
  value_if_launches_usd: number;
  odds: number;
  cohort_odds: number;
  implied_value_usd: number;
  range_low_usd: number;
  range_high_usd: number;
  farm: FarmEcon;
  farm_steps: string[];
}

export interface LiveRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

function firstChain(p: SnapProtocol): string {
  // v3.2: a protocol with no chains field (or an empty one) farms on
  // Ethereum by default instead of throwing on chains[0].
  const chains = Array.isArray(p.chains) ? p.chains : [];
  return chains.length > 0 ? chains[0]! : 'Ethereum';
}

function coreAction(p: SnapProtocol): string {
  const category = p.category ?? 'protocol';
  const chain = firstChain(p);
  if (category === 'Liquid Staking' || category === 'Liquid Restaking') return `stake on ${chain} and hold the receipt token`;
  if (category === 'DEXes') return `swap weekly on ${chain} and add liquidity when the pool is thin`;
  if (category === 'Lending') return `supply and borrow weekly on ${chain} without liquidating`;
  if (category === 'Yield') return `deposit into the vault on ${chain} and keep it through the week`;
  if (category === 'Derivatives') return `open and close small trades weekly on ${chain}`;
  return `use ${p.name} on ${chain} weekly and keep a balance`;
}

function joinStep(p: SnapProtocol, farm: FarmEcon): string {
  return `${coreAction(p)}, from a $100 minimum and a $20,000 cap, on ${firstChain(p)}.`;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function farmPlan(p: SnapProtocol, farm: FarmEcon, implied: number, options: FarmOptions): string[] {
  // The stored share is rounded to 4 decimals, which is 0.0000 for a
  // capped deposit against a multi-billion TVL; the display share is
  // recomputed from the deposit so it never reads 0.0000%.
  // v3.2: the display share guards the same TVL edge as farmEconomics.
  const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
  const displayShare = tvl > 0 ? farm.deposit / tvl : 0;
  const sharePct = displayShare * 100 >= 0.01 ? (displayShare * 100).toFixed(2) : (displayShare * 100).toFixed(4);
  const weeks = Math.round(farm.weeks);
  return [
    `Deposit ${money(farm.deposit)} into ${p.name} — 0.02% of its ${money(p.tvl_usd)} TVL, capped at $20,000 — and ${joinStep(p, farm)}`,
    `Hold for about ${weeks} weeks so the deposit is present across airdrop snapshots, about ${farm.hours} hours of upkeep in total.`,
    `Pay ${money(farm.fees)} of gas at $1.50 an action: ${money(farm.setupGas)} to set up on ${farm.chainsTouched} chain${farm.chainsTouched === 1 ? '' : 's'}, ${money(farm.weeklyGas)} a week, ${money(farm.claimGas)} to claim.`,
    `If the token lists, the drop pool is ${Math.round(options.poolPct * 100)}% of ${money(implied)} implied value, shared in proportion to deposit; a ${money(farm.deposit)} deposit is a ${sharePct}% share, so the gross share is ${money(farm.gross)}.`,
    `Keep a gas buffer in the wallet on each chain touched, and never move the deposit while it is farming, because a snapshot can happen any week.`,
    `Expected net is about ${money(farm.net)} after ${money(farm.fees)} of gas (${farm.verdict}: ${money(farm.netPerHour)} an hour, ${(farm.returnOnCapital * 100).toFixed(2)}% on a ${money(farm.deposit)} deposit).`,
  ];
}

export function buildBoard(
  snap: Snapshot,
  fit: PowerFit,
  odds: OddsTable,
  options: FarmOptions = FARM_DEFAULTS,
): BoardRow[] {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, { p: SnapProtocol; group: BoardGroup }>();
  // The watchlist is the floor: every slug on it is ranked, unconditionally.
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, { p, group: 'watchlist' });
  }
  // The early radar below the floor, and the off-list above it, both held
  // to the watchlist's own exclusions. No lower TVL bound: a pre-token
  // protocol below the floor is early, however small.
  for (const p of snap.protocols) {
    if (!chosen.has(p.slug) && passesExclusions(p) && p.tvl_usd < snap.floor_usd) chosen.set(p.slug, { p, group: 'early' });
  }
  for (const p of snap.protocols) {
    if (!chosen.has(p.slug) && passesExclusions(p) && p.tvl_usd >= snap.floor_usd) chosen.set(p.slug, { p, group: 'off-list' });
  }
  const scored = [...chosen.values()].map(({ p, group }) => {
    const s = scoreProtocol(p, snap.as_of, fit, odds);
    const farm = farmEconomics(p, s.implied, snap.as_of, options);
    const age = daysSince(snap.as_of, p.listed_at);
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      group,
      value_if_launches_usd: s.valueIf,
      odds: s.odds,
      cohort_odds: s.cohortOdds,
      implied_value_usd: s.implied,
      range_low_usd: s.rangeLow,
      range_high_usd: s.rangeHigh,
      farm,
      farm_steps: farmPlan(p, farm, s.implied, options),
    };
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  scored.forEach((r, i) => {
    r.rank = i + 1;
  });
  return scored;
}

/** The live-token set-aside: the largest market caps, exchanges excluded. */
export function liveSet(snap: Snapshot, count = LIVE_COUNT): LiveRow[] {
  return snap.protocols
    .filter((p) => recordsToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, count)
    .map((p, i) => ({
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

// ---------------------------------------------------------------------------
// Ledger: the snapshot accounted for — every protocol counted exactly once.
// ---------------------------------------------------------------------------

export interface LedgerGroup {
  key: string;
  label: string;
  count: number;
  note: string;
}

/**
 * The ledger: every one of the snapshot's protocols in exactly one group.
 * Ranked rows, priced comparables, and the set-aside per reason. The
 * counts sum to the snapshot's protocol count — the audit chips check it.
 */
export function buildLedger(snap: Snapshot, board: BoardRow[], fitComps: SnapProtocol[]): LedgerGroup[] {
  const ranked = new Set(board.map((r) => r.slug));
  const fitSet = new Set(fitComps.map((p) => p.slug));
  const compSet = new Set(snap.protocols.filter(isComparable).map((p) => p.slug));
  const count = (fn: (p: SnapProtocol) => boolean): number => snap.protocols.filter(fn).length;
  return [
    {
      key: 'watchlist',
      label: 'Ranked — watchlist',
      count: board.filter((r) => r.group === 'watchlist').length,
      note: 'TVL at or above the $50M floor, no token on record.',
    },
    {
      key: 'early',
      label: 'Ranked — early',
      count: board.filter((r) => r.group === 'early').length,
      note: 'Pre-token below the floor, held to the watchlist exclusions.',
    },
    {
      key: 'off-list',
      label: 'Ranked — off-list',
      count: board.filter((r) => r.group === 'off-list').length,
      note: 'Pre-token above the floor, off the watchlist, same exclusions.',
    },
    {
      key: 'comps',
      label: 'Token trades — priced comp',
      count: fitSet.size,
      note: 'Live-token protocols the size curve is fitted on.',
    },
    {
      key: 'comps-excluded',
      label: 'Token trades — category excluded',
      count: count((p) => !ranked.has(p.slug) && compSet.has(p.slug) && !fitSet.has(p.slug)),
      note: 'Bridge, liquid staking, restaking and exchange tokens: not priced as launches.',
    },
    {
      key: 'token-no-cap',
      label: 'Token on record — no usable cap',
      count: count((p) => !ranked.has(p.slug) && !compSet.has(p.slug) && recordsToken(p)),
      note: 'A token is recorded but no positive market cap is usable.',
    },
    {
      key: 'pre-token-aside',
      label: 'Pre-token — set aside',
      count: count((p) => !ranked.has(p.slug) && recordsNoToken(p)),
      note: 'Wrapped, staked, bridged, versioned or exchange products.',
    },
  ];
}

/** A short checksum over the ranked slugs and implied values; it must match the app's recompute. */
export function boardChecksum(rows: BoardRow[]): string {
  let h = 2166136261;
  for (const r of rows) {
    const s = `${r.slug}:${r.implied_value_usd};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// The payload: the board plus everything the dashboard shows or checks.
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  slug: string;
  rank: number;
  valueIf: number;
  odds: number;
}

export interface RadarRow {
  board: BoardRow[];
  live: LiveRow[];
  ledger: LedgerGroup[];
  fit: PowerFit;
  fit128: { n: number; intercept: number; slope: number; r2: number; looMiss: number; wfMiss: number; geoLooMiss: number; geoWfMiss: number };
  terms: TermTest[];
  odds: OddsTable;
  /** Distinct odds values on the board, and the largest share of rows at one value. */
  oddsSpread: { distinct: number; maxShare: number };
  /** Headline counts for the ledger bar. */
  counts: { total: number; live: number; preToken: number; ranked: number; watchlist: number };
  /** The farm assumptions, so the dashboard and the board can be audited against each other. */
  farmAssumptions: { poolPct: number; depositPct: number; depositCap: number; depositFloor: number };
  watchlist: string[];
  asOf: string;
  floorUsd: number;
  checksum: string;
  scatter: ScatterPoint[];
  model: string;
}

export function buildPayload(snap: Snapshot, board: BoardRow[]): RadarRow {
  const comps = snap.protocols.filter(isFitComparable);
  const fit = fitPowerLaw(comps);
  const comps128 = snap.protocols.filter(isComparable);
  const fit128 = fitPowerLaw(comps128);
  const terms = testTerms(comps, snap.as_of, fit);
  const odds = buildOdds(snap);
  const live = liveSet(snap);
  const ledger = buildLedger(snap, board, comps);
  const distinct = new Set(board.map((r) => r.odds)).size;
  const oddsCounts = new Map<number, number>();
  for (const r of board) oddsCounts.set(r.odds, (oddsCounts.get(r.odds) ?? 0) + 1);
  const maxShare = round4(Math.max(...[...oddsCounts.values()]) / board.length);
  const counts = {
    total: snap.protocols.length,
    live: snap.protocols.filter((p) => !recordsNoToken(p)).length,
    preToken: snap.protocols.filter((p) => recordsNoToken(p)).length,
    ranked: board.length,
    watchlist: snap.watchlist.length,
  };
  return {
    board,
    live,
    ledger,
    fit,
    fit128: {
      n: fit128.n,
      intercept: fit128.intercept,
      slope: fit128.slope,
      r2: fit128.r2,
      looMiss: fit128.looMiss,
      wfMiss: fit128.wfMiss,
      geoLooMiss: fit128.looGeoMiss,
      geoWfMiss: fit128.wfGeoMiss,
    },
    terms,
    odds,
    oddsSpread: { distinct, maxShare },
    counts,
    farmAssumptions: { poolPct: DROP_POOL_PCT, depositPct: DEPOSIT_PCT, depositCap: DEPOSIT_CAP, depositFloor: DEPOSIT_FLOOR },
    watchlist: snap.watchlist,
    asOf: snap.as_of,
    floorUsd: snap.floor_usd,
    checksum: boardChecksum(board),
    scatter: board.map((r) => ({ slug: r.slug, rank: r.rank, valueIf: r.value_if_launches_usd, odds: r.odds })),
    model: MODEL_ID,
  };
}

export function parseSnapshot(raw: string): Snapshot {
  // v3.2: restored v2-style input sanitization. v3/v3.1 trusted the input
  // completely (JSON.parse plus an array check); v2 validated the structure
  // and normalized every protocol, which is why v2 survived the dev input
  // while v3.1 died on it. The structure checks throw SnapshotError, as
  // in v2; a protocol that cannot be identified or priced is DROPPED
  // instead of thrown — v2's throw would abort the whole run (exit 1),
  // and a run that dies on one bad protocol is exactly the v3/v3.1 failure
  // mode. A dropped protocol never reaches the board, the farm, or the
  // odds; if it was a watchlist slug, boardIssue fails with a clear
  // message, which is the honest outcome for a broken input. On the kit
  // snapshot no protocol is dropped and no field is coerced, so the
  // parsed snapshot is identical to v3.1's.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = parsed as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapProtocol[] = [];
  for (const v of o.protocols) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) continue;
    protocols.push({
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    });
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Returns a reason when the board would not pass the bounty gate, otherwise null. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, the gate wants 100-4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  for (const [i, row] of board.entries()) {
    if (!slugs.has(row.slug)) return `row ${i + 1} slug ${row.slug} is not in the snapshot`;
    if (row.name.length === 0) return `row ${i + 1} has no name`;
    if (row.rank !== i + 1) return `row ${i + 1} has rank ${row.rank}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `row ${i + 1} has implied value ${row.implied_value_usd}`;
    }
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} implied value rises above row ${i}`;
    }
    if (row.odds < 0 || row.odds > 1) return `row ${i + 1} has odds ${row.odds}`;
    if (row.farm.verdict !== 'FARM' && row.farm.verdict !== 'THIN' && row.farm.verdict !== 'SKIP') {
      return `row ${i + 1} has verdict ${row.farm.verdict}`;
    }
    if (!Number.isFinite(row.farm.returnOnCapital)) return `row ${i + 1} has a non-finite return on capital`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${i + 1} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `row ${i + 1} has a farm step of ${step.length} chars`;
    }
  }
  for (const slug of snap.watchlist) {
    if (!board.some((r) => r.slug === slug)) return `watchlist slug ${slug} is not on the board`;
  }
  return null;
}

/**
 * The `data.js` payload as a single statement; `JSON.stringify` of the
 * whole payload, with no indentation, keeps the dashboard small and the
 * dossier byte-identical between runs.
 */
export function dataScript(payload: RadarRow): string {
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
