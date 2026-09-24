// Builds installable packages into dist/:
//   claude-for-zen.xpi      – with the trustedInput experiment (Zen, or any build with experiments enabled)
//   claude-for-firefox.zip  – experiment stripped, for official Firefox (sign via AMO as unlisted)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const webExt = join(root, 'node_modules/.bin/web-ext');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

function pack(sourceDir, filename) {
  execFileSync(webExt, ['build', '--source-dir', sourceDir, '--artifacts-dir', dist, '--filename', filename, '--overwrite-dest'], { stdio: 'inherit' });
}

pack(join(root, 'extension'), 'claude-for-zen.xpi');

const ff = join(dist, 'firefox-src');
cpSync(join(root, 'extension'), ff, { recursive: true, filter: (src) => !src.includes('/experiments') });
const manifest = JSON.parse(readFileSync(join(ff, 'manifest.json'), 'utf8'));
delete manifest.experiment_apis;
writeFileSync(join(ff, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
pack(ff, 'claude-for-firefox.zip');
rmSync(ff, { recursive: true });
