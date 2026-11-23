// Token Radar v2 — the entrypoint (Node 22, standard library only).
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

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildPayload, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap and the gate's screenshot and dashboard caps. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

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

const { board, payload } = buildPayload(snapshot);
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

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(payload));

const dashboardFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
if (dashboardFiles.length === 0) fail('dashboard/ holds no files to copy');
// The dossier's text shows the dashboard's source whole only while it fits
// in 65,536 bytes: refuse a dashboard past 60,000 bytes rather than hand
// the judge a cut-off page.
const dashboardBytes = dashboardFiles.reduce((sum, name) => sum + statSync(join(outDir, 'dashboard', name)).size, 0);
if (dashboardBytes > 60_000) fail(`dashboard/ source is ${dashboardBytes} bytes, past the 60,000-byte budget for the dossier text`);
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

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored ` +
    `(${payload.early_size} early, ${payload.off_list_size} off-list, ${payload.live_size} live set aside)\n` +
    `token radar: fit n=${payload.fit.n} slope=${payload.fit.slope} R²=${payload.fit.r2} LOO miss ×${payload.fit.looMiss} (flat ×${payload.fit.flatLooMiss}), ` +
    `odds Brier ${payload.odds.brier} vs base ${payload.odds.brierBase}, verdicts FARM ${payload.verdicts.FARM} / THIN ${payload.verdicts.THIN} / SKIP ${payload.verdicts.SKIP}, ` +
    `ledger ${payload.ledger_total}/${snapshot.protocols.length}, checksum ${payload.checksum}\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashboardFiles.length} files, ${dashboardBytes} bytes), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
