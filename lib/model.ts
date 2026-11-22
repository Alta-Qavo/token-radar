// Token Radar — the scoring model.
//
// One sealed snapshot in, one ranked board out. The board covers every slug
// on the snapshot's watchlist (the floor, never the ceiling) and adds the
// early radar: pre-token protocols below the floor that pass the same strict
// exclusion the watchlist rule uses, so wrapped, staked, bridged and
// versioned products never rank.
//
// A protocol "records no token" when its snapshot entry carries no market
// cap, no CoinGecko id and no symbol. That is a statement about the record,
// never a claim that no token exists.
//
// Implied value is built only from the snapshot's own figures:
//
//   compMultiple = shrunk category median of mcap/tvl over live-token
//                  protocols, pulled toward the global median, clamped
//                  to [0.05, 0.80]
//   growthMult   = 1 + clamp(change_7d, -50, 100) / 100 * 0.4
//   maturityMult = 0.7 + min(age_days, 1095) / 1095 * 0.3
//                  (age_days unknown: 365)
//   implied      = max(1, round(tvl_usd * compMultiple
//                               * growthMult * maturityMult))
//
// No protocol name is ever special-cased: the same functions score every
// row, and the dashboard shows the same arithmetic per row.

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
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** The model's fixed parameters, printed in the dashboard's method section. */
export interface ModelParams {
  growth_weight: number;
  growth_min: number;
  growth_max: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_min: number;
  multiple_max: number;
  shrink_prior: number;
  min_category_comps: number;
}

export const MODEL_ID = 'radar-comp-1';

export const MODEL: ModelParams = {
  growth_weight: 0.4,
  growth_min: -50,
  growth_max: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_min: 0.05,
  multiple_max: 0.8,
  shrink_prior: 3,
  min_category_comps: 3,
};

/** How many live-token protocols the dashboard sets aside, by market cap. */
export const LIVE_COUNT = 24;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The middle value of a sorted list; NaN when the list is empty. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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

/** A live-token protocol usable as a valuation comparable: it trades, has a market cap and a TVL.
 *  A market cap of zero or less is not a price: the snapshot carries one
 *  such quirk (a protocol whose mcap_usd is -1), and it is left out. */
export function isComparable(p: SnapProtocol): boolean {
  return (
    p.gecko_id !== null &&
    p.symbol !== null &&
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0
  );
}

export interface ComparableSet {
  /** Median mcap/tvl across every live-token comparable. */
  global: number;
  /** Per-category median and count, for categories with at least one comparable. */
  byCategory: Map<string, { median: number; n: number }>;
}

/** The comparable multiples: one global median and one median per category. */
export function comparableMultiples(snapshot: Snapshot): ComparableSet {
  const all: number[] = [];
  const perCat = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (!isComparable(p)) continue;
    const ratio = p.mcap_usd! / p.tvl_usd;
    all.push(ratio);
    const cat = p.category ?? 'Uncategorised';
    const list = perCat.get(cat);
    if (list === undefined) perCat.set(cat, [ratio]);
    else list.push(ratio);
  }
  const global = median(all);
  const byCategory = new Map<string, { median: number; n: number }>();
  for (const [cat, ratios] of perCat) byCategory.set(cat, { median: median(ratios), n: ratios.length });
  return { global, byCategory };
}

/**
 * The multiple applied to one protocol: its category median shrunk toward
 * the global median (prior weight 3) when the category has enough live
 * comparables, else the global median. Always clamped to [0.05, 0.80].
 */
export function appliedMultiple(category: string | null, comps: ComparableSet, model: ModelParams = MODEL): { applied: number; categoryMedian: number | null; categoryN: number } {
  const entry = category === null ? undefined : comps.byCategory.get(category);
  const n = entry === undefined ? 0 : entry.n;
  let multiple: number;
  let categoryMedian: number | null = null;
  if (entry !== undefined && n >= model.min_category_comps) {
    categoryMedian = entry.median;
    multiple = (n * entry.median + model.shrink_prior * comps.global) / (n + model.shrink_prior);
  } else {
    multiple = comps.global;
  }
  const applied = Math.min(model.multiple_max, Math.max(model.multiple_min, multiple));
  return { applied, categoryMedian, categoryN: n };
}

export interface ScoreBreakdown {
  implied: number;
  compApplied: number;
  compCategoryMedian: number | null;
  compCategoryN: number;
  compGlobal: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  ageDays: number | null;
}

/** One protocol's implied value and every number that produced it. */
export function scoreProtocol(p: SnapProtocol, asOf: string, comps: ComparableSet, model: ModelParams = MODEL): ScoreBreakdown {
  const { applied, categoryMedian, categoryN } = appliedMultiple(p.category, comps, model);
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(model.growth_max, Math.max(model.growth_min, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const age = daysSince(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * applied * growthMult * maturityMult));
  return {
    implied,
    compApplied: round4(applied),
    compCategoryMedian: categoryMedian === null ? null : round4(categoryMedian),
    compCategoryN: categoryN,
    compGlobal: round4(comps.global),
    growthPct: round4(growthPct),
    growthMult: round4(growthMult),
    maturityMult: round4(maturityMult),
    ageDays: age,
  };
}

// The watchlist rule's own exclusions, reused for the early radar so the
// two halves of the board are held to the same standard.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** The strict early-radar filter: pre-token, below the floor, and none of the watchlist's exclusions. */
export function passesEarlyFilter(p: SnapProtocol, floorUsd: number): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.tvl_usd >= floorUsd) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) if (p.name.startsWith(prefix)) return false;
  return true;
}

export interface ModelBreakdown {
  comp_applied: number;
  comp_category_median: number | null;
  comp_category_n: number;
  comp_global: number;
  growth_pct: number;
  growth_mult: number;
  maturity_mult: number;
}

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
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
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

/** One row of the dashboard's data file, with the farm plan attached. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_id: string;
  model: ModelParams;
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  categories: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The farm's working capital, sized from the protocol's own TVL. */
function workingCapital(p: SnapProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** The minimum hold, in days: younger protocols need a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
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
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use it inside the chain's apps.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and deploy the bridged funds in its app.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, then its cost and time. */
function joinStep(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each with a concrete cost and time.
 * The plan is derived from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list of names. It never claims a
 * token will launch or promises any reward: the protocol records no token.
 */
export function farmPlan(p: SnapProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const capital = workingCapital(p);
  const hold = holdDays(age);
  const gas = capital >= 200 ? 10 : capital >= 100 ? 6 : 4;
  return [
    joinStep(
      'Open a fresh wallet used only for this farm and store its seed phrase offline, never in a screenshot or a chat.',
      'no cost to create; under $3 of gas for the first transaction',
      '5 minutes',
    ),
    joinStep(coreAction(p, capital, chain), `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'),
    joinStep(
      'Return once a week and make one real on-chain action, such as a deposit, a swap, a borrow or a vote, so the wallet shows repeated use.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    joinStep(
      `Keep the position open for at least ${hold} days so it spans more than one activity snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    joinStep(
      "Before withdrawing, check the protocol's own rewards page and claim only through the link that page publishes, never through a link sent to you.",
      'free to check; never pay a fee to claim',
      '10 minutes',
    ),
    joinStep(
      'Record the wallet address, the dates and every transaction hash in a farm log so you can repeat the position or unwind it cleanly.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The ranked board: watchlist rows plus early rows, scored and ranked 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelParams = MODEL): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && passesEarlyFilter(p, snapshot.floor_usd)) chosen.set(p.slug, p);
  }
  const comps = comparableMultiples(snapshot);
  const scored = [...chosen.values()].map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, comps, model) }));
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
    watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.score.ageDays,
    implied_value_usd: s.score.implied,
    model: {
      comp_applied: s.score.compApplied,
      comp_category_median: s.score.compCategoryMedian,
      comp_category_n: s.score.compCategoryN,
      comp_global: s.score.compGlobal,
      growth_pct: s.score.growthPct,
      growth_mult: s.score.growthMult,
      maturity_mult: s.score.maturityMult,
    },
    farm_steps: farmPlan(s.p, s.score.ageDays),
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

/** Everything the dashboard renders, built from the same board main.ts writes. */
export function buildPayload(snapshot: Snapshot, model: ModelParams = MODEL): { board: BoardRow[]; payload: RadarPayload } {
  const board = buildBoard(snapshot, model);
  const live = liveSet(snapshot);
  const comps = comparableMultiples(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const categories = [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort();
  const payload: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_id: MODEL_ID,
    model,
    global_multiple: round4(comps.global),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    categories,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      watchlist: r.watchlist,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      model: r.model,
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
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

/** The dashboard's whole dataset as one script: window.RADAR, no fetch, no network. */
export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
