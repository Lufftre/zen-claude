// Builds installable packages into dist/:
//   claude-for-zen.xpi      – with the trustedInput experiment (Zen, or any build with experiments enabled)
//   claude-for-firefox.zip  – experiment stripped, for official Firefox (sign via AMO as unlisted)
//
// `--xpi FILE` builds only the Zen package, to FILE (the MCP server uses this to update the extension), and
// `--port N` makes N the extension's default port. Each package carries build.json naming the git tree of
// extension/, so the server can tell whether the installed extension is current.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { xpi: { type: 'string' }, port: { type: 'string' } } });
const root = new URL('..', import.meta.url).pathname;
const webExt = join(root, 'node_modules/.bin/web-ext');
const work = mkdtempSync(join(tmpdir(), 'zen-claude-build-'));

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
// Uncommitted changes have no tree to name, so such a build never counts as current.
const dirty = git('status', '--porcelain', '--', 'extension') !== '';
const build = { tree: dirty ? null : git('rev-parse', 'HEAD:extension'), commit: git('rev-parse', 'HEAD') };

function source(name, { experiment = true } = {}) {
  const dir = join(work, name);
  cpSync(join(root, 'extension'), dir, { recursive: true, filter: (src) => experiment || !src.includes('/experiments') });
  writeFileSync(join(dir, 'build.json'), `${JSON.stringify(build)}\n`);
  if (opts.port) {
    const bg = join(dir, 'background.js');
    writeFileSync(bg, readFileSync(bg, 'utf8').replaceAll('port: 8765', `port: ${Number(opts.port)}`));
  }
  if (!experiment) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    delete manifest.experiment_apis;
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

// Packs next to the destination and renames, so nobody installs a half-written package.
function pack(sourceDir, out) {
  const partial = `.partial-${process.pid}-${basename(out)}`;
  execFileSync(webExt, ['build', '--source-dir', sourceDir, '--artifacts-dir', dirname(out), '--filename', partial, '--overwrite-dest'], { stdio: ['ignore', 'ignore', 'inherit'] });
  renameSync(join(dirname(out), partial), out);
}

try {
  if (opts.xpi) {
    const out = resolve(opts.xpi);
    mkdirSync(dirname(out), { recursive: true });
    pack(source('zen'), out);
  } else {
    const dist = join(root, 'dist');
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist);
    pack(source('zen'), join(dist, 'claude-for-zen.xpi'));
    pack(source('firefox', { experiment: false }), join(dist, 'claude-for-firefox.zip'));
    console.log(`Built dist/claude-for-zen.xpi and dist/claude-for-firefox.zip${dirty ? ' (with uncommitted changes)' : ''}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
