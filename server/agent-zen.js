// Agent Zen: a second Zen, with a profile of its own, that holds the windows agents open with session_window. macOS
// treats it as an app of its own, with its own Dock icon, so Cmd-` in the user's Zen never cycles through agents'
// windows, and links from other apps keep going to the user's Zen. The hub starts it the first time an agent asks for
// a window of its own.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const AGENT_ZEN_PROFILE = process.env.ZEN_CLAUDE_AGENT_PROFILE ||
  join(homedir(), 'Library/Application Support/zen/Profiles/claude-agents');
const ZEN_APP = process.env.ZEN_CLAUDE_ZEN_APP || '/Applications/Zen.app';

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

export async function agentZenRunning() {
  const { stdout } = await execFileP('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').some((line) => line.includes(`-profile ${AGENT_ZEN_PROFILE}`) && !line.includes('-contentproc'));
}

// Starts agent Zen in the background, unless it is running. The first start installs the extension, built from this
// checkout, into the profile; after that it updates itself like the user's.
export async function startAgentZen({ root, port }) {
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
  // -n: a second instance, not the user's; -g: behind the app in front.
  await execFileP('open', ['-n', '-g', '-a', ZEN_APP, '--args', '-profile', AGENT_ZEN_PROFILE], { timeout: 10_000 });
  return true;
}
