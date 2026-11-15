// main.ts — FOUNDRY-9 entry program (Node 22, standard library only).
// Copies game/ and screenshots/ beside this file into the output directory
// (MAKEFUN_OUTPUT_DIR, else /output), validates the competition caps, then
// writes /output/dossier.json with the kit library buildDossier.
// Run outside the grader as: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

function fail(msg) {
  console.error(`main.ts: ${msg}`);
  process.exit(1);
}

function walk(dir, rel, out_list) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`symlink not allowed: ${join(rel, name)}`);
    if (st.isDirectory()) walk(p, join(rel, name), out_list);
    else if (st.isFile()) out_list.push({ path: join(rel, name), bytes: st.size });
    else fail(`not a plain file: ${join(rel, name)}`);
  }
  return out_list;
}

const gameDir = join(root, 'game');
const shotsDir = join(root, 'screenshots');
if (!existsSync(gameDir)) fail('game/ is missing');
if (!existsSync(shotsDir)) fail('screenshots/ is missing');

// Validate the caps before writing anything.
const gameFiles = walk(gameDir, '', []);
if (gameFiles.length > 993) fail(`game/ has ${gameFiles.length} entries (cap 993)`);
const gameBytes = gameFiles.reduce((s, f) => s + f.bytes, 0);
if (gameBytes > 50331648) fail(`game/ is ${gameBytes} bytes (cap 48 MiB)`);
const shotNames = readdirSync(shotsDir).sort().filter(n => !n.startsWith('.'));
if (shotNames.length > 4) fail(`screenshots/ has ${shotNames.length} files (cap 4)`);
if (shotNames.length < 3) fail(`screenshots/ has ${shotNames.length} files (need at least 3)`);
for (const n of shotNames) {
  const st = statSync(join(shotsDir, n));
  if (!st.isFile()) fail(`screenshot is not a file: ${n}`);
  if (st.size > 262144) fail(`screenshot ${n} is ${st.size} bytes (cap 256 KiB)`);
}

// Copy game/ and screenshots/ into the output directory (fresh each run).
// NEVER remove the output directory itself: in the grader /output is a bind
// mount, and rmdir on a mount point fails EBUSY (run_completes FAIL, round 1).
// Empty its contents instead and leave the directory in place.
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) rmSync(join(out, name), { recursive: true, force: true });
cpSync(gameDir, join(out, 'game'), { recursive: true });
cpSync(shotsDir, join(out, 'screenshots'), { recursive: true });

// buildDossier reads game/ + screenshots/ from the output directory and
// returns the dossier.json bytes (it does not write the file itself).
const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(out, 'dossier.json'), dossier);
console.log(`main.ts: wrote ${join(out, 'dossier.json')} (${dossier.length} bytes; ${gameFiles.length} game files, ${gameBytes} bytes, ${shotNames.length} screenshots)`);
