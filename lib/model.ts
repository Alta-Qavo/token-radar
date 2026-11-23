// Token Radar v2 — fitted launch pricing.
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
//       a pre-token launch). Typical held-out miss: median x3.69
//       leave-one-out, x2.23 older-to-newer, against a flat median
//       multiple at x4.53 / x4.09.
//   odds = (0.94 - share) / (1 - share), share = the fraction of
//       protocols in the same age cohort that already record a token.
//       The ceiling 0.94 is the assumed eventual listing share; the
//       oldest cohort already records 0.79. Brier 0.215 against a base
//       rate of 0.250.
//   implied = max(1, round(value_if_launches * odds))
//
// Extra terms (growth, age, chain count, category residual) were each
// tested leave-one-out AND older-to-newer, under both the median miss and
// the geometric-mean miss; none won both tests under both measures, so
// none is kept. A shuffled-growth control term also wins nothing, which
// is what a real test should show — and it calibrates the noise: the
// control "wins" the median LOO test by 4% by pure chance, so a win
// smaller than that is not evidence. The evidence table in the dashboard
// prints every test, kept or dropped.
//
// Farm economics are net of costs: a deposit sized by TVL tier, gas
// per chain touched, a hold in weeks by age, and a drop share of
// 0.00001 of implied value (10% of supply shared by 10,000 farmers).
// Net per hour decides the verdict: FARM at $50/h or more, THIN at
// $10/h or more, else SKIP. No protocol name is ever special-cased.

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

export const MODEL_ID = 'radar-fit-2';

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

/** One farmer's share of implied value if a token lists: 10% of supply / 10,000 farmers. */
export const DROP_SHARE_DEFAULT = 0.00001;

/** Net-per-hour lines for the farm verdicts. */
export const VERDICT_FARM_HOURLY = 50;
export const VERDICT_THIN_HOURLY = 10;

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
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!) ) piv = r;
    const tmpRow = a[c]!;
    a[c] = a[piv]!;
    a[piv] = tmpRow;
    const tmpB = b[c]!;
    b[c] = b[piv]!;
    b[piv] = tmpB;
    for (let r = c + 1; r < k; r++) {
      const f = a[r]![c]! / a[c]![c]!;
      for (let j = c; j < k; j++) a[r]![j]! -= f * a[c]![j]!;
      b[r] = b[r]! - f * b[c]!;
    }
  }
  const beta = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < k; j++) s -= a[i]![j]! * beta[j]!;
    beta[i] = s / a[i]![i]!;
  }
  return beta;
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

type ExtraKind = 'growth' | 'age' | 'chains' | 'catresid' | 'control';

/** One extra feature on top of the size curve, or 0 when the term is the base. */
function extraFeature(p: SnapProtocol, asOf: string, kind: ExtraKind, catMap: Map<string, number> | null): number {
  if (kind === 'growth') return (typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0) / 100;
  if (kind === 'age') {
    const age = daysSince(asOf, p.listed_at);
    return Math.log10((age ?? 365) + 1);
  }
  if (kind === 'chains') return p.chains.length;
  if (kind === 'catresid') return catMap === null ? 0 : catMap.get(p.category ?? 'null') ?? 0;
  if (kind === 'control') return p._control ?? 0;
  return 0;
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
    const rows = train.map((p) => [...sizeRow(p.tvl_usd), extraFeature(p, asOf, kind, catMap)]);
    const beta = leastSquares(rows, trainY);
    const held = comps[i]!;
    const row = [...sizeRow(held.tvl_usd), extraFeature(held, asOf, kind, catMap)];
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
  const betaWf = leastSquares(train.map((p) => [...sizeRow(p.tvl_usd), extraFeature(p, asOf, kind, catMap)]), trainY);
  const wfPred = test.map((p) => Math.pow(10, dot([...sizeRow(p.tvl_usd), extraFeature(p, asOf, kind, catMap)], betaWf)));
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
  const kinds: ExtraKind[] = ['growth', 'age', 'chains', 'catresid', 'control'];
  return kinds.map((k) => testOneTerm(comps, asOf, k, base));
}

// ---------------------------------------------------------------------------
// Token odds from age cohorts.
// ---------------------------------------------------------------------------

export interface Cohort {
  label: string;
  minDays: number;
  maxDays: number;
  n: number;
  tokenShare: number;
  odds: number;
}

export interface OddsTable {
  ceiling: number;
  cohorts: Cohort[];
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
  const baseRate = dated.filter(recordsToken).length / dated.length;
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
  brier /= dated.length;
  brierBase /= dated.length;

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
// Scoring, ranges, farm economics.
// ---------------------------------------------------------------------------

export interface ScoreDetail {
  valueIf: number;
  odds: number;
  implied: number;
  rangeLo: number;
  rangeHi: number;
  rangeLo90: number;
  rangeHi90: number;
  ageDays: number | null;
}

/** One protocol's implied value, range and odds, from the fitted curve. */
export function scoreProtocol(p: SnapProtocol, asOf: string, fit: PowerFit, odds: OddsTable): ScoreDetail {
  const valueIf = valueIfLaunches(p.tvl_usd, fit);
  const age = daysSince(asOf, p.listed_at);
  const o = oddsFor(age, odds);
  const implied = Math.max(1, Math.round(valueIf * o));
  const band = (lo: number, hi: number): [number, number] => [
    Math.max(1, Math.round(valueIf * Math.pow(10, lo) * o)),
    Math.max(1, Math.round(valueIf * Math.pow(10, hi) * o)),
  ];
  const [rangeLo, rangeHi] = band(fit.rangeP25, fit.rangeP75);
  const [rangeLo90, rangeHi90] = band(fit.rangeP10, fit.rangeP90);
  return { valueIf: Math.round(valueIf), odds: o, implied, rangeLo, rangeHi, rangeLo90, rangeHi90, ageDays: age };
}

/** The farm's working capital, sized from the protocol's own TVL. */
export function depositFor(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 500;
  if (tvlUsd >= 100_000_000) return 250;
  if (tvlUsd >= 50_000_000) return 150;
  return 100;
}

/** The minimum hold, in days: younger protocols need a longer qualifying window. */
export function holdDays(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 180) return 90;
  if (ageDays < 365) return 60;
  return 30;
}

export interface FarmEcon {
  deposit: number;
  depositPct: number;
  chainsTouched: number;
  weeks: number;
  setupGas: number;
  weeklyGas: number;
  claimGas: number;
  fees: number;
  hours: number;
  gross: number;
  net: number;
  netPerHour: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  dropShare: number;
}

export interface FarmOptions {
  dropShare: number;
  horizonMult: number;
}

export const FARM_DEFAULTS: FarmOptions = { dropShare: DROP_SHARE_DEFAULT, horizonMult: 1 };

/**
 * The farm's net economics. Capital is returned, so it is not a cost;
 * gas is. Gross is the position's share of implied value if a token
 * lists: the drop share is a stated assumption, not a fact.
 */
export function farmEconomics(p: SnapProtocol, ageDays: number | null, implied: number, opts: FarmOptions = FARM_DEFAULTS): FarmEcon {
  const deposit = depositFor(p.tvl_usd);
  const chainsTouched = Math.min(Math.max(p.chains.length, 1), 3);
  const weeks = (holdDays(ageDays) / 7) * opts.horizonMult;
  const setupGas = 4 + 2 * chainsTouched;
  const weeklyGas = 2 * chainsTouched;
  const claimGas = 5;
  const fees = Math.round((setupGas + weeklyGas * weeks + claimGas) * 100) / 100;
  const hours = Math.round((0.25 + weeks * 0.17 + 0.17) * 100) / 100;
  const gross = Math.round(implied * opts.dropShare * 100) / 100;
  const net = Math.round((gross - fees) * 100) / 100;
  const netPerHour = Math.round((net / hours) * 100) / 100;
  const verdict = netPerHour >= VERDICT_FARM_HOURLY ? 'FARM' : netPerHour >= VERDICT_THIN_HOURLY ? 'THIN' : 'SKIP';
  return {
    deposit,
    depositPct: round4(deposit / p.tvl_usd),
    chainsTouched,
    weeks: round2(weeks),
    setupGas,
    weeklyGas,
    claimGas,
    fees,
    hours,
    gross,
    net,
    netPerHour,
    verdict,
    dropShare: opts.dropShare,
  };
}

// The watchlist rule's own exclusions, reused for the early and off-list
// radar so every ranked row is held to the same standard.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** The watchlist's exclusions, without the floor: pre-token, not an exchange, not versioned, not wrapped. */
export function passesExclusions(p: SnapProtocol): boolean {
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
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  group: BoardGroup;
  age_days: number | null;
  implied_value_usd: number;
  odds: number;
  value_if_launches_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  range_lo90_usd: number;
  range_hi90_usd: number;
  fit: { intercept: number; slope: number; r2: number; n: number };
  farm: FarmEcon;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's core action, in words a reader can follow on-chain. */
function coreAction(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open a single small hedged position.`;
  if (c.includes('risk curator') || c.includes('capital allocator')) return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farm wallet.`;
  if (c.includes('stablecoin')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} across at least two separate transfers.`;
  if (c.includes('governance')) return `Lock $${capital} of assets in ${name}'s governance vault on ${chain} and cast one vote.`;
  if (c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's native asset through ${name} and keep the receipt token.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and hold the position.`;
  if (c.includes('cedefi')) return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the balance inside the app.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('chain') || c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and deploy the bridged funds in its app.`;
  if (c.includes('farm')) return `Stake $${capital} of LP tokens in ${name}'s farm on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, then its cost and time. */
function joinStep(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

function money(n: number): string {
  return n < 0 ? `-$${Math.abs(Math.round(n))}` : `$${Math.round(n)}`;
}

/**
 * A protocol's farm plan: six steps, each with a concrete cost and time,
 * derived from the protocol's own record (category, TVL tier, chain count,
 * age) and its net economics. It never claims a token will launch or
 * promises any reward: the protocol records no token.
 */
export function farmPlan(p: SnapProtocol, age: number | null, econ: FarmEcon): string[] {
  const chain = firstChain(p);
  const capital = econ.deposit;
  const hold = holdDays(age);
  const netLine =
    econ.net >= 0
      ? `net about ${money(econ.net)} after ${money(econ.fees)} of gas (${econ.verdict} at ${money(econ.netPerHour)} an hour)`
      : `net about ${money(econ.net)} after ${money(econ.fees)} of gas (${econ.verdict}: the gas costs more than the expected share)`;
  return [
    joinStep(
      'Open a fresh wallet used only for this farm and store its seed phrase offline, never in a screenshot or a chat.',
      'no cost to create; under $3 of gas for the first transaction',
      '5 minutes',
    ),
    joinStep(coreAction(p, capital, chain), `${money(capital)} of capital and about ${money(econ.setupGas)} of gas`, '15 minutes to set up'),
    joinStep(
      `Return once a week for ${econ.weeks.toFixed(0)} weeks and make one real on-chain action on each of the ${econ.chainsTouched} chain${econ.chainsTouched === 1 ? '' : 's'} you farm, such as a deposit, a swap, a borrow or a vote.`,
      `about ${money(econ.weeklyGas)} of gas a week`,
      '10 minutes a week',
    ),
    joinStep(
      `Keep the position open for at least ${hold} days so it spans more than one activity snapshot.`,
      `the ${money(capital)} stays in the position`,
      `${hold} days`,
    ),
    joinStep(
      "Before withdrawing, check the protocol's own rewards page and claim only through the link that page publishes, never through a link sent to you.",
      'free to check; never pay a fee to claim',
      '10 minutes',
    ),
    joinStep(
      `The plan's arithmetic: a ${money(capital)} deposit, ${money(econ.fees)} of gas over ${econ.hours} hours, ${netLine}. Record every transaction hash in a farm log so you can repeat the position or unwind it cleanly.`,
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The ranked board: watchlist rows, early rows, off-list rows, scored and ranked 1..N. */
export function buildBoard(snapshot: Snapshot, fit: PowerFit, odds: OddsTable): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, { p: SnapProtocol; group: BoardGroup }>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, { p, group: 'watchlist' });
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && passesExclusions(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, { p, group: 'early' });
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && passesExclusions(p) && p.tvl_usd >= snapshot.floor_usd) chosen.set(p.slug, { p, group: 'off-list' });
  }
  const scored = [...chosen.values()].map(({ p, group }) => {
    const score = scoreProtocol(p, snapshot.as_of, fit, odds);
    const econ = farmEconomics(p, score.ageDays, score.implied);
    return { p, group, score, econ };
  });
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    group: s.group,
    age_days: s.score.ageDays,
    implied_value_usd: s.score.implied,
    odds: s.score.odds,
    value_if_launches_usd: s.score.valueIf,
    range_lo_usd: s.score.rangeLo,
    range_hi_usd: s.score.rangeHi,
    range_lo90_usd: s.score.rangeLo90,
    range_hi90_usd: s.score.rangeHi90,
    fit: { intercept: fit.intercept, slope: fit.slope, r2: fit.r2, n: fit.n },
    farm: s.econ,
    farm_steps: farmPlan(s.p, s.score.ageDays, s.econ),
  }));
}

/** The live-token set-aside: the largest market caps, exchanges excluded. */
export function liveSet(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_COUNT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export interface LedgerGroup {
  key: string;
  label: string;
  count: number;
  note: string;
}

/**
 * The ledger: every one of the snapshot's protocols in exactly one group.
 * Ranked rows, priced comparables, and the set-aside per reason.
 */
export function buildLedger(snapshot: Snapshot, board: BoardRow[], fitComps: SnapProtocol[]): LedgerGroup[] {
  const ranked = new Set(board.map((r) => r.slug));
  const fitSet = new Set(fitComps.map((p) => p.slug));
  const compSet = new Set(snapshot.protocols.filter(isComparable).map((p) => p.slug));
  const groups: LedgerGroup[] = [];
  const count = (fn: (p: SnapProtocol) => boolean): number => snapshot.protocols.filter(fn).length;
  groups.push({
    key: 'watchlist',
    label: 'Ranked — watchlist',
    count: board.filter((r) => r.group === 'watchlist').length,
    note: 'TVL at or above the $50M floor, no token on record.',
  });
  groups.push({
    key: 'early',
    label: 'Ranked — early',
    count: board.filter((r) => r.group === 'early').length,
    note: 'Pre-token below the floor, held to the watchlist exclusions.',
  });
  groups.push({
    key: 'off-list',
    label: 'Ranked — off-list',
    count: board.filter((r) => r.group === 'off-list').length,
    note: 'Pre-token above the floor, off the watchlist, same exclusions.',
  });
  groups.push({
    key: 'comps',
    label: 'Token trades — priced comp',
    count: fitSet.size,
    note: 'Live-token protocols the size curve is fitted on.',
  });
  groups.push({
    key: 'comps-excluded',
    label: 'Token trades — category excluded',
    count: count((p) => !ranked.has(p.slug) && compSet.has(p.slug) && !fitSet.has(p.slug)),
    note: 'Bridge, liquid staking, restaking and exchange tokens: not priced as launches.',
  });
  groups.push({
    key: 'token-no-cap',
    label: 'Token on record — no usable cap',
    count: count((p) => !ranked.has(p.slug) && !compSet.has(p.slug) && recordsToken(p)),
    note: 'A token is recorded but no positive market cap is usable.',
  });
  groups.push({
    key: 'pre-token-aside',
    label: 'Pre-token — set aside',
    count: count((p) => !ranked.has(p.slug) && recordsNoToken(p)),
    note: 'Wrapped, staked, bridged, versioned or exchange products.',
  });
  return groups;
}

/** A 32-bit FNV-1a checksum over the board's slugs and implied values. */
export function boardChecksum(board: BoardRow[]): string {
  let hash = 0x811c9dc5;
  const text = board.map((r) => `${r.slug}:${r.implied_value_usd}`).join(',');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface ScatterPoint {
  slug: string;
  tvl: number;
  mcap: number;
  kind: 'comp' | 'board';
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  group: BoardGroup;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  odds: number;
  value_if_launches_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  range_lo90_usd: number;
  range_hi90_usd: number;
  fit: { intercept: number; slope: number; r2: number; n: number };
  farm: FarmEcon;
  farm_steps: string[];
}

export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_id: string;
  fit: PowerFit;
  odds: OddsTable;
  terms: TermTest[];
  fit128: { n: number; looMiss: number; wfMiss: number; geoLooMiss: number; geoWfMiss: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  off_list_size: number;
  live_size: number;
  verdicts: { FARM: number; THIN: number; SKIP: number };
  total_implied_usd: number;
  ledger: LedgerGroup[];
  ledger_total: number;
  checksum: string;
  categories: string[];
  scatter: ScatterPoint[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Everything the dashboard renders, built from the same board main.ts writes. */
export function buildPayload(snapshot: Snapshot): { board: BoardRow[]; payload: RadarPayload } {
  const fitComps = snapshot.protocols.filter(isFitComparable);
  const allComps = snapshot.protocols.filter(isComparable);
  const fit = fitPowerLaw(fitComps);
  const fit128 = fitPowerLaw(allComps);
  const odds = buildOdds(snapshot);
  const terms = testTerms(fitComps, snapshot.as_of, fit);
  const board = buildBoard(snapshot, fit, odds);
  const live = liveSet(snapshot);
  const ledger = buildLedger(snapshot, board, fitComps);
  const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdicts[r.farm.verdict]++;
  const scatter: ScatterPoint[] = [
    ...fitComps.map((p) => ({ slug: p.slug, tvl: p.tvl_usd, mcap: p.mcap_usd!, kind: 'comp' as const })),
    ...board.map((r) => ({ slug: r.slug, tvl: r.tvl_usd, mcap: r.implied_value_usd, kind: 'board' as const })),
  ];
  const payload: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_id: MODEL_ID,
    fit,
    odds,
    terms,
    fit128: { n: fit128.n, looMiss: fit128.looMiss, wfMiss: fit128.wfMiss, geoLooMiss: fit128.looGeoMiss, geoWfMiss: fit128.wfGeoMiss },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => r.group === 'early').length,
    off_list_size: board.filter((r) => r.group === 'off-list').length,
    live_size: live.length,
    verdicts,
    total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
    ledger,
    ledger_total: ledger.reduce((s, g) => s + g.count, 0),
    checksum: boardChecksum(board),
    categories: [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort(),
    scatter,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      group: r.group,
      watchlist: r.group === 'watchlist',
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      odds: r.odds,
      value_if_launches_usd: r.value_if_launches_usd,
      range_lo_usd: r.range_lo_usd,
      range_hi_usd: r.range_hi_usd,
      range_lo90_usd: r.range_lo90_usd,
      range_hi90_usd: r.range_hi90_usd,
      fit: r.fit,
      farm: r.farm,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, payload };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapProtocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
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
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null when it passes every check. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const seen = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
    if (seen.has(r.slug)) return `${r.slug} appears twice on the board`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!(r.odds >= 0 && r.odds <= 1)) return `${r.slug} has odds ${r.odds}`;
    if (r.farm.verdict !== 'FARM' && r.farm.verdict !== 'THIN' && r.farm.verdict !== 'SKIP') return `${r.slug} has verdict ${r.farm.verdict}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

/** The dashboard's whole dataset as one script: window.RADAR, no fetch, no network. */
export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
