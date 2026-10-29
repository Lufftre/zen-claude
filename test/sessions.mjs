// Checks session labels and "Show terminal" routing without a browser: plays the extension against a hub and a
// peer server, with a stub rex that reports a pane title and logs what it was asked to do.
// Run: node test/sessions.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const PORT = 8790 + Math.floor(Math.random() * 100);
const dir = mkdtempSync(join(tmpdir(), 'zen-claude-sessions-'));
const logFile = join(dir, 'rex.log');
writeFileSync(logFile, '');
writeFileSync(join(dir, 'rex'), `#!/bin/sh
echo "$REX_BLOCK $*" >> "${logFile}"
[ "$2" = call ] && echo '{"title":"✳ Title of '"$REX_BLOCK"'"}'
exit 0
`);
chmodSync(join(dir, 'rex'), 0o755);

const start = async (env) => {
  const client = new Client({ name: 'sessions', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node',
    args: ['server/index.js'],
    env: { ...process.env, ZEN_CLAUDE_PORT: String(PORT), REX_BIN_DIR: dir, REX_SESSION: '', ...env },
  }));
  return client;
};

// The first server binds the hub; give it a moment before the second one arrives as a peer.
const hub = await start({ REX_BLOCK: 'block:hub' });
await new Promise((r) => setTimeout(r, 500));
const peer = await start({ REX_BLOCK: '' });
const peer2 = await start({ REX_BLOCK: 'block:peer' });

const extension = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'moz-extension://test' });
await new Promise((r) => extension.once('open', r));
const seen = [];
extension.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.method === 'tabs_context') seen.push(msg.session); // not the extension_info each session starts with
  extension.send(JSON.stringify({ id: msg.id, result: { text: 'ok' } }));
});

for (const client of [hub, peer, peer2]) {
  const r = await client.callTool({ name: 'tabs_context', arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
}
const [hubSess, peerSess, peer2Sess] = seen;
assert.equal(hubSess.label, 'Title of block:hub');
assert.equal(hubSess.terminal, true);
assert.equal(peerSess.label, basename(process.cwd())); // no pane, so the folder
assert.equal(peerSess.terminal, false);
assert.equal(peer2Sess.label, 'Title of block:peer');

const focusLog = () => readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('focus'));
for (const sess of [peer2Sess, hubSess, peerSess, { id: 'unknown' }]) {
  extension.send(JSON.stringify({ type: 'focusTerminal', session: sess.id }));
}
await new Promise((r) => setTimeout(r, 1000));
assert.deepEqual(focusLog().sort(), ['block:hub block focus block:hub', 'block:peer block focus block:peer']);

// A server with newer code takes the hub over; the extension reconnects to it, and "Show terminal" reaches sessions
// started before it, the old hub included, without them making another call.
let extension2;
extension.once('close', async () => {
  for (let i = 0; i < 40 && extension2?.readyState !== WebSocket.OPEN; i++) {
    await new Promise((r) => setTimeout(r, 250));
    extension2 = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'moz-extension://test' });
    extension2.on('message', (data) => {
      const msg = JSON.parse(data);
      extension2.send(JSON.stringify({ id: msg.id, result: { text: 'ok' } }));
    });
    await new Promise((r) => { extension2.once('open', r); extension2.once('error', r); });
  }
});
const newer = await start({ REX_BLOCK: 'block:newer', ZEN_CLAUDE_CODE: 'newer' });
const r = await newer.callTool({ name: 'tabs_context', arguments: {} });
assert.equal(r.isError, undefined, r.content[0].text);
assert.equal(extension2.readyState, WebSocket.OPEN);
await new Promise((r) => setTimeout(r, 1500)); // the old hub rejoins as a peer
writeFileSync(logFile, '');
for (const sess of [hubSess, peer2Sess]) extension2.send(JSON.stringify({ type: 'focusTerminal', session: sess.id }));
await new Promise((r) => setTimeout(r, 1000));
assert.deepEqual(focusLog().sort(), ['block:hub block focus block:hub', 'block:peer block focus block:peer']);

console.log('ok: labels', seen.map((s) => s.label), '\nfocus requests:', focusLog());
extension2.close();
await Promise.all([hub, peer, peer2, newer].map((c) => c.close()));
