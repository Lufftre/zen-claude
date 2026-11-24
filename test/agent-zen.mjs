// Checks that a session's own window opens in agent Zen, a second Zen the hub starts itself, and that the session
// can work there. Runs its own hub on another port with a throwaway agent profile, so it doesn't touch the user's
// Zen or the sessions using it:
//   node test/agent-zen.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.ZEN_CLAUDE_TEST_PORT || '8799';
const profile = mkdtempSync(join(tmpdir(), 'zen-claude-agents-'));
const server = new URL('../server/index.js', import.meta.url).pathname;

async function session(name) {
  const client = new Client({ name, version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, ZEN_CLAUDE_PORT: PORT, ZEN_CLAUDE_AGENT_PROFILE: profile, ZEN_CLAUDE_AUTO_UPDATE: '0' },
    stderr: 'inherit',
  }));
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { error: r.isError, text, images: r.content.filter((c) => c.type === 'image') };
  };
  return { client, call };
}

const zenPids = () => execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n')
  .filter((l) => l.includes(`-profile ${profile}`) && !l.includes('-contentproc'))
  .map((l) => Number(l.trim().split(/\s+/)[0]));

const page = createServer((req, res) => res.end('<title>agent zen</title><h1>hello from agent Zen</h1>')).listen(0, '127.0.0.1');
await new Promise((r) => page.once('listening', r));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

try {
  const a = await session('a');

  // No user's Zen listens on this port, so calls for it fail; that shows where a call went.
  const shared = await a.call('tabs_context');
  assert.ok(shared.error && /not connected/.test(shared.text), `expected the user's Zen to be absent: ${shared.text}`);

  let t = Date.now();
  const own = await a.call('session_window', { name: 'agent-zen test' });
  assert.ok(!own.error, own.text);
  console.log(`session_window started agent Zen in ${Date.now() - t} ms:\n${own.text}`);
  assert.equal(zenPids().length, 1, 'one agent Zen');
  const windows = (await a.call('tabs_context', { all_windows: true })).text.match(/^Window \d+/gm);
  assert.equal(windows.length, 1, `the session took agent Zen's start window, not a new one: ${windows}`);

  const created = await a.call('tabs_create', { url: pageUrl });
  assert.ok(!created.error, created.text);
  const text = await a.call('get_page_text');
  assert.match(text.text, /hello from agent Zen/);
  const shot = await a.call('computer', { action: 'screenshot' });
  assert.ok(!shot.error && shot.images.length === 1, `screenshot: ${shot.text}`);
  const ctx = await a.call('tabs_context');
  assert.match(ctx.text, /this session's window/);
  console.log('worked in agent Zen: page text, screenshot, tabs_context');

  // A second session gets a window of its own in the same agent Zen.
  const b = await session('b');
  t = Date.now();
  const ownB = await b.call('session_window', { name: 'second session' });
  assert.ok(!ownB.error, ownB.text);
  assert.equal(zenPids().length, 1, 'still one agent Zen');
  assert.notEqual(/window is (\d+)/.exec(ownB.text)[1], /window is (\d+)/.exec(own.text)[1], 'separate windows');
  console.log(`second session's window in ${Date.now() - t} ms`);

  // Closing goes back to the user's Zen.
  const closed = await a.call('session_window', { close: true });
  assert.ok(!closed.error, closed.text);
  const after = await a.call('tabs_context');
  assert.ok(after.error && /not connected/.test(after.text), `expected the user's Zen after closing: ${after.text}`);
  // Marks are the user's.
  const marks = await b.call('get_marked_areas');
  assert.ok(marks.error && /not connected/.test(marks.text), `marks went to agent Zen: ${marks.text}`);
  console.log('close and marks go to the user\'s Zen');

  await a.client.close();
  await b.client.close();
  console.log('ok');
} finally {
  page.close();
  for (const pid of zenPids()) process.kill(pid);
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(profile, { recursive: true, force: true });
}
