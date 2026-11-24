// Agent Zen: a second Zen, with a profile of its own, that holds the windows agents open with session_window. It runs
// as "Zen Agents", a copy of Zen.app with its own bundle id and an orange icon, so macOS treats it as an app of its
// own: its own Dock icon (with a badge counting agents' windows), and Cmd-` in the user's Zen never cycles through
// agents' windows. Links from other apps keep going to the user's Zen. The hub starts it the first time an agent asks
// for a window of its own.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const AGENT_ZEN_PROFILE = process.env.ZEN_CLAUDE_AGENT_PROFILE ||
  join(homedir(), 'Library/Application Support/zen/Profiles/claude-agents');
const ZEN_APP = process.env.ZEN_CLAUDE_ZEN_APP || '/Applications/Zen.app';
const AGENTS_APP = process.env.ZEN_CLAUDE_AGENTS_APP || join(homedir(), 'Library/Application Support/zen-claude/Zen Agents.app');
const AGENTS_BUNDLE_ID = 'app.zen-browser.zen.agents';
const ICON = new URL('agent-zen-icon.png', import.meta.url).pathname;

// zen-claude.role tells the extension which Zen it is in. The rest lets the unsigned extension, with its experiment,
// load from the profile without asking, and keeps Zen from greeting anyone or restoring old windows.
const PREFS = {
  'zen-claude.role': 'agents',
  'extensions.experiments.enabled': true,
  'xpinstall.signatures.required': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 15,
  'zen.welcome-screen.seen': true,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.startup.page': 0,
  'browser.sessionstore.resume_from_crash': false,
};

const processes = async () => (await execFileP('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n');

export async function agentZenRunning() {
  return (await processes()).some((line) => line.includes(`-profile ${AGENT_ZEN_PROFILE}`) && !line.includes('-contentproc'));
}

const plist = async (app, key) =>
  (await execFileP('plutil', ['-extract', key, 'raw', join(app, 'Contents/Info.plist')]).catch(() => ({ stdout: '' }))).stdout.trim();

// What the copy is made from: Zen's build and our icon. A change to either makes a new copy.
async function sourceStamp() {
  return `${await plist(ZEN_APP, 'CFBundleVersion')} ${readFileSync(ICON).length}`;
}

// Makes "Zen Agents.app" from Zen.app, unless the one there is from this Zen and icon. A copy-on-write clone, so it
// takes no room; the changed Info.plist and icon break Zen's signature, so it is signed again, ad hoc, for this Mac.
// Zen's updater is turned off in the copy: a new Zen gives a new copy instead.
async function agentsApp() {
  const stamp = await sourceStamp();
  if (existsSync(AGENTS_APP) && (await plist(AGENTS_APP, 'ZenClaudeSource')) === stamp) return AGENTS_APP;
  // A copy in use stays until agent Zen next starts.
  if (existsSync(AGENTS_APP) && (await processes()).some((line) => line.startsWith(AGENTS_APP))) return AGENTS_APP;
  mkdirSync(dirname(AGENTS_APP), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'zen-agents-'));
  try {
    const app = join(work, 'Zen Agents.app');
    await execFileP('cp', ['-cR', ZEN_APP, app]);
    const info = join(app, 'Contents/Info.plist');
    for (const [key, value] of [['CFBundleIdentifier', AGENTS_BUNDLE_ID], ['CFBundleName', 'Zen Agents'],
      ['CFBundleDisplayName', 'Zen Agents'], ['ZenClaudeSource', stamp]]) {
      await execFileP('plutil', ['-replace', key, '-string', value, info]);
    }
    const iconset = join(work, 'icon.iconset');
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
        const px = String(size * scale);
        await execFileP('sips', ['-z', px, px, ICON, '--out', join(iconset, `icon_${size}x${size}${suffix}.png`)]);
      }
    }
    const iconFile = (await plist(app, 'CFBundleIconFile')) || 'firefox';
    await execFileP('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents/Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`)]);
    mkdirSync(join(app, 'Contents/Resources/distribution'), { recursive: true });
    writeFileSync(join(app, 'Contents/Resources/distribution/policies.json'), JSON.stringify({ policies: { DisableAppUpdate: true } }));
    await execFileP('xattr', ['-cr', app]);
    await execFileP('codesign', ['--force', '--deep', '--sign', '-', app], { timeout: 120_000 });
    rmSync(AGENTS_APP, { recursive: true, force: true });
    renameSync(app, AGENTS_APP);
    return AGENTS_APP;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Starts agent Zen in the background, unless it is running. The first start installs the extension, built from this
// checkout, into the profile; after that it updates itself like the user's. Without a Zen Agents copy it runs Zen.app
// itself, which works the same but shares Zen's Dock icon.
export async function startAgentZen({ root, port, log = () => {} }) {
  if (process.platform !== 'darwin') throw new Error('agent Zen is only set up for macOS');
  if (!existsSync(ZEN_APP)) throw new Error(`no Zen at ${ZEN_APP}`);
  if (await agentZenRunning()) return false;
  mkdirSync(join(AGENT_ZEN_PROFILE, 'extensions'), { recursive: true });
  writeFileSync(join(AGENT_ZEN_PROFILE, 'user.js'),
    Object.entries(PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(''));
  // Zen finds an extension in the profile by its id as the file name; web-ext won't write an @ in one.
  const xpi = join(AGENT_ZEN_PROFILE, 'extensions', 'zen-claude@local.xpi');
  if (!existsSync(xpi)) {
    const built = join(AGENT_ZEN_PROFILE, 'extensions', 'zen-claude.xpi');
    await execFileP(process.execPath, [join(root, 'scripts/build.mjs'), '--xpi', built, ...(port === 8765 ? [] : ['--port', String(port)])],
      { timeout: 60_000 });
    renameSync(built, xpi);
  }
  const app = await agentsApp().catch((err) => {
    log(`could not make Zen Agents.app (${err.message}); running Zen.app`);
    return ZEN_APP;
  });
  // -n: a second instance, not the user's; -g: behind the app in front.
  await execFileP('open', ['-n', '-g', '-a', app, '--args', '-profile', AGENT_ZEN_PROFILE], { timeout: 10_000 });
  return true;
}
