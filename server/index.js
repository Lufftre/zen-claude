#!/usr/bin/env node
// MCP server that bridges Claude Code to the Zen/Firefox extension.
//
// The first server process to start binds a WebSocket hub on 127.0.0.1. The
// extension connects to the hub; any further server processes (other Claude
// sessions) connect to the hub as peers and have their requests relayed.
// If the hub process exits, a peer takes over the port on its next request.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { TOOLS } from './tools.js';

const PORT = Number(process.env.ZEN_CLAUDE_PORT || 8765);
const HOST = '127.0.0.1';
const PEER_HEADER = 'x-zen-claude-peer';
const CODE_HEADER = 'x-zen-claude-code';
const STARTED_HEADER = 'x-zen-claude-started';
// The hub decides what reaches the extension and the other sessions, so it should run the newest code. Servers compare
// a fingerprint of their source; a hub that finds a server started after it with different code hands the port over.
// ZEN_CLAUDE_CODE stands in for it in tests.
const CODE = process.env.ZEN_CLAUDE_CODE || createHash('sha1')
  .update(['index.js', 'tools.js'].map((f) => readFileSync(new URL(f, import.meta.url))).join('\0'))
  .digest('hex');
const STARTED = Date.now();
// A server on another machine reaches the hub through a Unix socket that SSH forwards to the browser's machine
// (`ssh -R <socket>:127.0.0.1:8765`). sshd creates it readable by our user only, so other accounts on this machine
// can't drive the browser, as they could through a forwarded TCP port. Such a server can only ever be a peer: it
// can't take the port over, since the browser can't reach it, and it can't hand the extension an .xpi on its disk.
const HUB_SOCKET = process.env.ZEN_CLAUDE_HUB_SOCKET || '';
const REMOTE = !!HUB_SOCKET;
const HUB_URL = REMOTE ? `ws+unix:${HUB_SOCKET}:/` : `ws://${HOST}:${PORT}`;
const SUPERSEDED = 409;
const REQUEST_TIMEOUT_MS = 60_000;
const EXTENSION_GRACE_MS = 5_000;
// Identifies this Claude session to the extension, which keeps per-session state such as a dedicated window. The
// label names that window; terminal says whether the extension can ask us to bring our terminal pane forward.
const SESSION = {
  id: randomUUID(),
  ownWindow: process.env.ZEN_CLAUDE_WINDOW === '1',
  label: basename(process.cwd()),
  terminal: !!process.env.REX_BLOCK,
};

const log = (...args) => console.error('[zen-claude]', ...args);

class Bridge {
  constructor() {
    this.mode = null; // 'hub' | 'peer'
    this.wss = null;
    this.extension = null; // hub: socket to the extension
    this.hubSocket = null; // peer: socket to the hub
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.relayed = new Map(); // hub: relayed id -> { peer, originalId }
    this.peerSessions = new Map(); // hub: session id -> peer socket
    this.nextId = 1;
    this.connecting = null;
  }

  ensure() {
    if (this.mode === 'hub') return Promise.resolve();
    if (this.mode === 'peer' && this.hubSocket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= this.#join().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  // An older hub turns us away once it has started giving up the port, so try again until it has.
  async #join() {
    for (let attempt = 0; ; attempt++) {
      if (REMOTE) {
        return await this.#becomePeer().catch((err) => {
          throw new Error(`Can't reach the zen-claude hub through ${HUB_SOCKET} (${err.message}). It is forwarded ` +
            'from the machine with the browser, which needs the tunnel running (scripts/remote-tunnel.sh) and a ' +
            'Claude session using zen-browser.');
        });
      }
      try {
        return await this.#becomeHub();
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
      try {
        return await this.#becomePeer();
      } catch (err) {
        if (!err.message.includes(String(SUPERSEDED)) || attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  #becomeHub() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: HOST, port: PORT, verifyClient: (info, cb) => this.#verify(info, cb) });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (err) => log('hub error', err.message));
        this.wss = wss;
        this.mode = 'hub';
        log(`hub listening on ws://${HOST}:${PORT}`);
        wss.on('connection', (ws, req) => this.#onHubConnection(ws, req));
        resolve();
      });
    });
  }

  // A server with newer code than ours takes over: turn it away while we close the port, and it retries as the hub.
  #verify({ req }, cb) {
    const code = req.headers[CODE_HEADER];
    const newer = req.headers[PEER_HEADER] && code && code !== CODE && Number(req.headers[STARTED_HEADER]) > STARTED;
    if (!newer) return cb(true);
    cb(false, SUPERSEDED, 'a server with newer code is taking over');
    this.#stepDown();
  }

  #stepDown() {
    if (this.mode !== 'hub') return;
    log('handing the hub over to a server with newer code');
    const wss = this.wss;
    this.wss = null;
    this.mode = null;
    this.extension = null;
    this.relayed.clear();
    this.peerSessions.clear();
    for (const client of wss.clients) client.terminate();
    wss.close();
    this.#failPending('The zen-claude hub moved to a newer server; retry the request.');
    // Rejoin as a peer, so the browser can reach this session again without waiting for its next tool call.
    setTimeout(() => this.ensure().catch((err) => log('rejoining:', err.message)), 1000);
  }

  #failPending(message) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  #onHubConnection(ws, req) {
    const origin = req.headers.origin || '';
    if (origin.startsWith('moz-extension://')) {
      // First browser wins; others back off and retry until it disconnects.
      if (this.extension?.readyState === WebSocket.OPEN) return ws.close(4001, 'another browser is connected');
      this.extension = ws;
      log('extension connected');
      ws.on('message', (data) => this.#onExtensionMessage(data));
      ws.on('close', () => {
        if (this.extension === ws) this.extension = null;
        log('extension disconnected');
      });
    } else if (!origin && req.headers[PEER_HEADER]) {
      // Browsers always send Origin on WebSocket handshakes, so a page can't get here.
      log('peer connected');
      ws.on('message', (data) => this.#onPeerMessage(ws, data));
      ws.on('close', () => {
        for (const [id, peer] of this.peerSessions) if (peer === ws) this.peerSessions.delete(id);
      });
    } else {
      ws.close(4003, 'forbidden');
    }
  }

  #onExtensionMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'hello') return log('extension', msg.version, msg.browser || '');
    // The user asked, from the browser, to see the terminal pane running a session.
    if (msg.type === 'focusTerminal') {
      if (msg.session === SESSION.id) return focusTerminal();
      const peer = this.peerSessions.get(msg.session);
      if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'focusTerminal' }));
      return;
    }
    const relay = this.relayed.get(msg.id);
    if (relay) {
      this.relayed.delete(msg.id);
      if (relay.peer.readyState === WebSocket.OPEN) relay.peer.send(JSON.stringify({ ...msg, id: relay.originalId }));
      return;
    }
    this.#settle(msg);
  }

  #onPeerMessage(peer, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.session?.id) this.peerSessions.set(msg.session.id, peer);
    if (msg.type === 'hello') return;
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      peer.send(JSON.stringify({ id: msg.id, error: NOT_CONNECTED }));
      return;
    }
    const id = `r${this.nextId++}`;
    this.relayed.set(id, { peer, originalId: msg.id });
    this.extension.send(JSON.stringify({ ...msg, id }));
  }

  #becomePeer() {
    return new Promise((resolve, reject) => {
      // Without the code header, the hub never hands the port over to a remote server.
      const headers = { [PEER_HEADER]: '1', ...(!REMOTE && { [CODE_HEADER]: CODE }), [STARTED_HEADER]: String(STARTED) };
      const ws = new WebSocket(HUB_URL, { headers });
      ws.once('open', () => {
        this.hubSocket = ws;
        this.mode = 'peer';
        log('connected to existing hub as peer');
        // Let the hub know this session is here, so it can pass on "Show terminal" before our first request.
        ws.send(JSON.stringify({ type: 'hello', session: SESSION }));
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'focusTerminal') return focusTerminal();
        this.#settle(msg);
      });
      ws.on('close', () => {
        if (this.hubSocket !== ws) return;
        this.hubSocket = null;
        this.mode = null;
        this.#failPending('Lost connection to the zen-claude hub; retry the request.');
        // The hub may have gone to a newer server; rejoin so the browser can still reach this session.
        setTimeout(() => this.ensure().catch((err) => log('rejoining:', err.message)), 1000);
      });
    });
  }

  // The extension polls every couple of seconds, so give it a moment right after startup.
  async #waitForExtension(ms) {
    const deadline = Date.now() + ms;
    while (this.extension?.readyState !== WebSocket.OPEN && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  #settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  async call(method, params) {
    await Promise.all([this.ensure(), refreshLabel()]);
    if (this.mode === 'hub') await this.#waitForExtension(EXTENSION_GRACE_MS);
    const socket = this.mode === 'hub' ? this.extension : this.hubSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s waiting for the browser.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, session: SESSION }));
    });
  }
}

// Rex (the terminal multiplexer) tells programs which pane they run in. Claude Code sets the pane's title to the
// conversation's title, which names this session's window far better than the folder does.
const execFileP = promisify(execFile);
const REX = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, 'rex') : 'rex';
const LABEL_TTL_MS = 10_000;
let labelCheckedAt = 0;

async function refreshLabel() {
  if (!process.env.REX_BLOCK || Date.now() - labelCheckedAt < LABEL_TTL_MS) return;
  labelCheckedAt = Date.now();
  try {
    const { stdout } = await execFileP(REX, ['block', 'call', '--block', process.env.REX_BLOCK, 'title'], { timeout: 2000 });
    // Drop the spinner or status glyph Claude Code puts in front of the title.
    const title = JSON.parse(stdout).title?.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (title && title !== 'Claude Code') SESSION.label = title;
  } catch (err) {
    log('could not read the terminal title:', err.message);
  }
}

// Shows this session's Rex pane: switch the app to its session, focus the pane and bring Rex to the front.
async function focusTerminal() {
  const { REX_BLOCK, REX_SESSION } = process.env;
  if (!REX_BLOCK) return;
  try {
    if (REX_SESSION) await execFileP(REX, ['do', 'session.select', `session_id=${REX_SESSION}`], { timeout: 5000 });
    await execFileP(REX, ['block', 'focus', REX_BLOCK], { timeout: 5000 });
    if (process.platform === 'darwin') await execFileP('open', ['-b', 'com.superlogical.rex'], { timeout: 5000 });
  } catch (err) {
    log('could not focus the terminal pane:', err.message);
  }
}

// New sessions should get the extension as it is on main, so a session's first call updates it when this checkout,
// on main with extension/ committed, has a different one. ZEN_CLAUDE_AUTO_UPDATE names another branch to follow,
// or is 0 to turn this off. Sessions already running carry on with whatever the browser has.
const ROOT = new URL('..', import.meta.url).pathname;
const UPDATE_BRANCH = process.env.ZEN_CLAUDE_AUTO_UPDATE ?? 'main';
const UPDATE_WAIT_MS = 20_000;

async function currentTree() {
  if (UPDATE_BRANCH === '0' || REMOTE) return null;
  const git = async (...args) => (await execFileP('git', ['-C', ROOT, ...args], { timeout: 5000 })).stdout.trim();
  if ((await git('rev-parse', '--abbrev-ref', 'HEAD')) !== UPDATE_BRANCH) return null;
  if (await git('status', '--porcelain', '--', 'extension')) return null;
  return git('rev-parse', 'HEAD:extension');
}

// Returns a note for the session when the extension is out of date and could not be updated.
async function updateExtension() {
  const tree = await currentTree();
  if (!tree) return null;
  const manualUpdate = (version) => `The browser extension (${version}) is not the one in ${ROOT}, and can't update itself. ` +
    'Ask the user to run `npm run ext:build` there and open dist/claude-for-zen.xpi in Zen.';
  // Versions before 0.1.7 can't tell.
  const info = await bridge.call('extension_info', {}).catch((err) => {
    if (/Unknown method/.test(err.message)) return { version: 'an old version', build: {}, canUpdate: false };
    throw err;
  });
  // A build of null is an unpacked extension (about:debugging, web-ext run), which the developer reloads.
  if (!info.build || info.build.tree === tree) return null;
  if (!info.canUpdate) return manualUpdate(info.version);
  const xpi = join(tmpdir(), 'zen-claude-builds', `${tree}${PORT === 8765 ? '' : `-${PORT}`}.xpi`);
  if (!existsSync(xpi)) {
    await execFileP(process.execPath, [join(ROOT, 'scripts/build.mjs'), '--xpi', xpi, ...(PORT === 8765 ? [] : ['--port', String(PORT)])], { timeout: 60_000 });
  }
  log('updating the extension from', info.version, 'to', tree.slice(0, 8));
  await bridge.call('self_update', { xpi });
  // The extension reloads and reconnects; carry on once it reports the new build.
  const deadline = Date.now() + UPDATE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await bridge.call('extension_info', {}).catch(() => null);
    if (now?.build?.tree === tree) return log('extension updated to', now.version), null;
  }
  return 'Updating the browser extension did not finish; it may still be running an older version.';
}

let updateNote = null;
let updated = null;
function updateOnce() {
  updated ??= updateExtension()
    .then((note) => { updateNote = note; })
    .catch((err) => {
      log('could not update the extension:', err.message);
      // Try again once the browser is there.
      if (err.message === NOT_CONNECTED) updated = null;
    });
  return updated;
}

const NOT_CONNECTED =
  'The Zen/Firefox extension is not connected. Make sure the browser is running with the ' +
  '"Claude for Zen" extension loaded and enabled (check the toolbar icon).';

// Unless told otherwise, agents work in a window of their own so they don't take over the user's tabs. Pages the user
// points at stay in the user's window, so that is left to the agent to judge rather than forced.
const WINDOW_INSTRUCTIONS = {
  '1': 'All your calls use a browser window of your own. ',
  '0': '',
}[process.env.ZEN_CLAUDE_WINDOW] ??
  'For work of your own, such as testing an app, research or filling in forms, call session_window first, so you ' +
  'work in a window of your own and do not switch tabs in the window the user is looking at. Use the user\'s ' +
  'window only when they point you at a page they have open, have marked something, or ask you to. ';

const bridge = new Bridge();
// Bind early so the extension can connect before the first tool call.
bridge.ensure().catch((err) => log('startup:', err.message));

const server = new Server(
  { name: 'zen-browser', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Tools for controlling the user\'s Zen/Firefox browser. Start with tabs_context to see open tabs. ' +
      'Prefer read_page/find + ref-based actions over coordinates; use screenshots to verify visual state. ' +
      'Use form_input for native <select> elements. ' +
      WINDOW_INSTRUCTIONS +
      'When the user refers to ' +
      'something they boxed, marked or pointed at on the page, call get_marked_areas, and tick each mark off with ' +
      'resolve_marks once it is dealt with. Use highlight to point things out to the user.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (!TOOLS.some((t) => t.name === name)) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  try {
    await updateOnce();
    const result = toContent(await bridge.call(name, args));
    if (updateNote) {
      result.content.push({ type: 'text', text: updateNote });
      updateNote = null;
    }
    return result;
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
});

// The extension returns { text?, image?: { data, mimeType }, images?: [...] }.
function toContent(result) {
  const content = [];
  for (const image of [result?.image, ...(result?.images || [])].filter(Boolean)) {
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  if (result?.text != null) content.push({ type: 'text', text: String(result.text) });
  if (!content.length) content.push({ type: 'text', text: result === undefined ? 'OK' : JSON.stringify(result, null, 2) });
  return { content };
}

// The WebSocket server would otherwise keep the process alive after Claude Code goes away.
const shutdown = () => process.exit(0);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
server.onclose = shutdown;

await server.connect(new StdioServerTransport());
log('MCP server ready');
