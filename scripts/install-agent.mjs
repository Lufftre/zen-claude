// Installs the browser agent's native messaging host, so the extension's terminal can reach Rex: a launcher that runs
// agent/host.js with this Node (Zen starts hosts without a shell's PATH), and the manifest Zen looks it up by. Zen, like
// Firefox, reads manifests from ~/Library/Application Support/Mozilla/NativeMessagingHosts. Run it again after moving
// the repo or changing Node.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const support = join(homedir(), 'Library/Application Support');
const launcher = join(support, 'zen-claude', 'browser-agent-host');
mkdirSync(join(support, 'zen-claude'), { recursive: true });
// The node on PATH, such as Homebrew's /opt/homebrew/bin/node, which outlives upgrades; else this one.
const node = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim() || process.execPath;
writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(join(root, 'agent/host.js'))}\n`);
chmodSync(launcher, 0o755);

const dir = join(support, 'Mozilla', 'NativeMessagingHosts');
mkdirSync(dir, { recursive: true });
const manifest = {
  name: 'zen_claude_agent',
  description: 'Claude for Zen: the browser agent terminal (⌘J), bridged to Rex',
  path: launcher,
  type: 'stdio',
  allowed_extensions: ['zen-claude@local'],
};
writeFileSync(join(dir, 'zen_claude_agent.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Installed the browser agent host:\n  ${join(dir, 'zen_claude_agent.json')}\n  ${launcher}`);
