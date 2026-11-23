// Token Radar v3 — the entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, scores the pre-token board with lib/model.ts,
// and writes everything the gate and the judge read:
//
//   /output/board.json     { rows: [...] }, the ranked board
//   /output/data.js        window.RADAR, the dashboard's whole dataset
//   /output/dashboard/    a copy of this repository's dashboard/
//   /output/screenshots/  a copy of this repository's screenshots/
//   /output/dossier.json  the vendor buildDossier's summary, written last
//                          so it matches the files above byte for byte
//
// Run it locally with:
//   node main.ts --input ../input/snapshot.json --output out
//
// The run is deterministic: the same snapshot always writes the same
// bytes. It refuses to write a board the gate would refuse, and exits 1
// with the reason on stderr.
//
// v3 changes: the board's odds come from a logistic fitted at runtime, the
// farm plans are pro-rata by deposit, and the headline numbers are burned
// into the dashboard as literal text — a model card injected into the
// copied index.html — so the dossier's text carries the fit, the held-out
// misses, the odds' Brier scores and the totals, not just the code.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildBoard,
  buildOdds,
  buildPayload,
  dataScript,
  fitPowerLaw,
  isFitComparable,
  parseSnapshot,
  type RadarRow,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap and the gate's screenshot and dashboard caps. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The dashboard must stay under this so the dossier's text shows it whole. */
const DASHBOARD_BUDGET = 60_000;

function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** The value after `--name <value>` or `--name=<value>`, else the fallback. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
} catch (err) {
  fail(err instanceof Error ? err.message : 'snapshot.json could not be read');
}

// The fit and the odds are fitted once here for the board; buildPayload
// fits them again from the same snapshot, deterministically, for the
// dashboard's evidence tables.
const comps = snapshot.protocols.filter(isFitComparable);
const fit = fitPowerLaw(comps);
const dated = snapshot.protocols.filter((p) => p.listed_at !== null);
const odds = buildOdds(dated, snapshot.as_of);
const board = buildBoard(snapshot, fit, odds);
const payload: RadarRow = buildPayload(snapshot, board);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

/** Copy a directory's regular files into `to`, skipping dot-names, and return what was copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/**
 * The model card: the headline numbers as literal text in the dashboard,
 * so the dossier's text — which is only the dashboard and the screenshots
 * — carries the fit, the held-out misses, the odds' Brier scores and the
 * totals. Every number comes from this run's computation, never typed.
 * The card is under 2 KB by construction: one section, one paragraph.
 */
function modelCard(payload: RadarRow): string {
  const f = payload.fit;
  const o = payload.odds;
  const totalImplied = payload.board.reduce((s, r) => s + r.implied_value_usd, 0);
  const cohortLine = o.cohorts.map((c) => `${c.label} ${c.share}`).join(', ');
  const oddsDistinct = payload.oddsSpread.distinct;
  const top = payload.board[0]!;
  const fmtImplied = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
  return (
    `<section class="model-card" aria-label="Model card"><h2>Model card</h2>` +
    `<p>Fit on ${f.n} live-token comparables: log10(mcap) = ${f.intercept} + ${f.slope}·log10(TVL), R² ${f.r2}. ` +
    `Held-out miss ×${f.looMiss} leave-one-out, ×${f.wfMiss} older-to-newer (flat median ×${f.flatLooMiss} / ×${f.flatWfMiss}). ` +
    `Odds: logistic on ${o.logistic.n} dated protocols, Brier ${o.logistic.brierLoo} leave-one-out vs cohort ${o.brierCohort} and base ${o.logistic.brierBase}; ` +
    `odds take ${oddsDistinct} distinct values across the board. Cohorts: ${cohortLine}. ` +
    `Board: ${payload.board.length} rows, ${payload.counts.watchlist}/${payload.counts.watchlist} watchlist, ` +
    `${payload.counts.total} protocols counted, $${(totalImplied / 1e9).toFixed(2)}B total implied, ` +
    `top ${top.name} ${fmtImplied(top.implied_value_usd)} (odds ${top.odds}), checksum ${payload.checksum}.</p></section>`
  );
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(payload));

const dashboardFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
if (dashboardFiles.length === 0) fail('dashboard/ holds no files to copy');
// Inject the model card into the copied index.html, then measure the
// dashboard with the card in it — the budget must hold after injection.
const indexPath = join(outDir, 'dashboard', 'index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
if (!indexHtml.includes('<!--MODEL_CARD-->')) fail('dashboard/index.html has no <!--MODEL_CARD--> placeholder to inject into');
const card = modelCard(payload);
if (card.length > 2048) fail(`model card is ${card.length} bytes, past the 2,048-byte budget`);
writeFileSync(indexPath, indexHtml.replace('<!--MODEL_CARD-->', card));
const dashboardBytes = dashboardFiles.reduce((sum, name) => sum + statSync(join(outDir, 'dashboard', name)).size, 0);
if (dashboardBytes > DASHBOARD_BUDGET) {
  fail(`dashboard/ source is ${dashboardBytes} bytes, past the ${DASHBOARD_BUDGET}-byte budget for the dossier text`);
}
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
const groups = { watchlist: 0, early: 0, 'off-list': 0 };
for (const row of board) {
  verdicts[row.farm.verdict] += 1;
  groups[row.group] += 1;
}
const ledgerTotal = payload.ledger.reduce((s, g) => s + g.count, 0);
const ledgerGroups = payload.ledger.map((g) => `${g.key} ${g.count}`).join(', ');

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored ` +
    `(${groups.watchlist} watchlist, ${groups.early} early, ${groups['off-list']} off-list, ${payload.live.length} live set aside)\n` +
    `token radar: fit n=${payload.fit.n} slope=${payload.fit.slope} R²=${payload.fit.r2} LOO miss ×${payload.fit.looMiss} (flat ×${payload.fit.flatLooMiss}), ` +
    `odds Brier ${payload.odds.logistic.brierLoo} LOO vs cohort ${payload.odds.brierCohort} and base ${payload.odds.logistic.brierBase}, ` +
    `odds ${payload.oddsSpread.distinct} distinct values, verdicts FARM ${verdicts.FARM} / THIN ${verdicts.THIN} / SKIP ${verdicts.SKIP}, ` +
    `ledger ${ledgerTotal}/${snapshot.protocols.length} (${ledgerGroups}), checksum ${payload.checksum}\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashboardFiles.length} files, ${dashboardBytes} bytes, model card ${card.length} bytes), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
