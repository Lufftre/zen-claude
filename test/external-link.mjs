// Checks that a link from another app stays out of a session's window. Needs the test instance with chrome
// debugging, which is how the test hands the browser a link the way the OS would:
//   scripts/test-instance.sh --pref devtools.chrome.enabled=true --pref devtools.debugger.prompt-connection=false &
//   node test/external-link.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const port = Number(process.env.ZEN_DEBUGGER_PORT || /-start-debugger-server (\d+)/.exec(execSync('pgrep -fl firefox-profile').toString())?.[1]);
assert.ok(port, 'no test instance with a debugger server is running');

// Firefox remote debugging protocol: "<length>:<json>" packets.
const socket = connect(port, '127.0.0.1');
const waiting = [];
let buffer = Buffer.alloc(0);
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const colon = buffer.indexOf(':');
    if (colon < 0) return;
    const length = Number(buffer.subarray(0, colon));
    if (buffer.length < colon + 1 + length) return;
    const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
    buffer = buffer.subarray(colon + 1 + length);
    const i = waiting.findIndex((w) => w.match(packet));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(packet);
    else if (packet.type === 'evaluationResult') unclaimed.push(packet); // can arrive before anyone waits for it
  }
});
const unclaimed = [];
const next = (match) => {
  const i = unclaimed.findIndex(match);
  if (i >= 0) return Promise.resolve(unclaimed.splice(i, 1)[0]);
  return new Promise((resolve) => waiting.push({ match, resolve }));
};
const request = (packet, match = (p) => p.from === packet.to && !p.type) => {
  const json = JSON.stringify(packet);
  socket.write(`${Buffer.byteLength(json)}:${json}`);
  return next(match);
};
await next((p) => p.from === 'root');
const { processDescriptor } = await request({ to: 'root', type: 'getProcess', id: 0 });
const { process: parent } = await request({ to: processDescriptor.actor, type: 'getTarget' });

// Runs in the browser's parent process and returns a JSON-able value.
async function chrome(body) {
  const text = `JSON.stringify((() => { ${body} })())`;
  const { resultID } = await request({ to: parent.consoleActor, type: 'evaluateJSAsync', text });
  const done = await next((p) => p.type === 'evaluationResult' && p.resultID === resultID);
  assert.ok(!done.hasException, `chrome code threw: ${JSON.stringify(done.exception?.preview ?? done.exceptionMessage)}`);
  return typeof done.result === 'string' ? JSON.parse(done.result) : undefined;
}

const TRACKER = `const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");`;
// What BrowserContentHandler does with a URL from the OS: hand it to the most recently activated window.
const openExternal = (url) => chrome(`${TRACKER}
  const top = BrowserWindowTracker.getTopWindow({ private: false });
  top.browserDOMWindow.openURI(Services.io.newURI(${JSON.stringify(url)}), null, Ci.nsIBrowserDOMWindow.OPEN_DEFAULTWINDOW,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL, Services.scriptSecurityManager.getSystemPrincipal());
  return top.document.documentElement.hasAttribute("zen-unsynced-window");`);
// Each window, most recently activated first: whether it is a session's, and its tabs' URLs.
const windows = () => chrome(`${TRACKER}
  return BrowserWindowTracker.orderedWindows.map(w => ({
    session: !!w.document.getElementById("claude-for-zen-window-label"),
    urls: w.gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec),
  }));`);
const settle = () => new Promise((r) => setTimeout(r, 1500));
const where = async (marker) => (await windows()).filter((w) => w.urls.some((u) => u.includes(marker)));

// Pages to open; top-level data: URLs are refused for links from outside.
const pages = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>${req.url}</title>` + (req.url === '/opener' ? '<a target="_blank" href="/popup">open popup</a>' : ''));
}).listen(0, '127.0.0.1');
await new Promise((r) => pages.once('listening', r));
const page = (name) => `http://127.0.0.1:${pages.address().port}/${name}`;

const client = new Client({ name: 'external-link', version: '0' });
await client.connect(new StdioClientTransport({
  command: 'node',
  args: ['server/index.js'],
  env: { ...process.env, ZEN_CLAUDE_PORT: process.env.ZEN_CLAUDE_PORT || '8766', ZEN_CLAUDE_WINDOW: '1', ZEN_CLAUDE_AUTO_UPDATE: '0' },
}));
const tool = async (name, args = {}) => {
  let r;
  for (let i = 0; i < 15; i++) {
    r = await client.callTool({ name, arguments: args });
    if (!r.isError) return r.content[0].text;
    await new Promise((res) => setTimeout(res, 1000)); // the extension retries its connection every 2s
  }
  throw new Error(r.content[0].text);
};

try {
  // Windows left by sessions of earlier runs.
  await chrome(`for (const w of Services.wm.getEnumerator("navigator:browser"))
    if (w.document.getElementById("claude-for-zen-window-label")) w.close();`);
  await settle();
  await tool('session_window');
  await settle();
  assert.equal((await windows()).filter((w) => w.session).length, 1, 'expected one session window');

  // The session's window is made the most recent one, as when the user looked at it or it took input while another
  // app was in front. That is where the link would go.
  await chrome(`for (const w of Services.wm.getEnumerator("navigator:browser"))
    if (w.document.getElementById("claude-for-zen-window-label")) w.dispatchEvent(new w.Event("activate"));`);
  assert.equal((await windows())[0].session, true, 'the session window should be the most recent');
  assert.equal(await openExternal(page('link-one')), true, 'the link should be handed to the session window');
  await settle();
  let found = await where('link-one');
  assert.equal(found.length, 1, `the link should have opened once: ${JSON.stringify(await windows())}`);
  assert.equal(found[0].session, false, "the link opened in the session's window");

  // The session's own tabs still open in its window.
  await tool('tabs_create', { url: page('agent-tab') });
  await settle();
  found = await where('agent-tab');
  assert.equal(found[0]?.session, true, "the session's own tab should be in its window");

  // So do pages its clicks open in a new tab, which go through the same object as links from outside.
  await tool('tabs_create', { url: page('opener') });
  const ref = /ref_\d+/.exec(await tool('find', { query: 'open popup' }))?.[0];
  await tool('computer', { action: 'left_click', ref });
  await settle();
  found = await where('popup');
  assert.equal(found[0]?.session, true, `a tab opened by a click in the session's window should stay there: ${JSON.stringify(await windows())}`);

  // With no window of the user's open, the link gets a new window instead of the session's.
  await chrome(`for (const w of Services.wm.getEnumerator("navigator:browser"))
    if (!w.document.getElementById("claude-for-zen-window-label")) w.close();`);
  await settle();
  assert.equal((await windows()).length, 1, 'only the session window should be left');
  await openExternal(page('link-three'));
  await settle();
  await settle();
  found = await where('link-three');
  assert.equal(found.length, 1, `the link should have opened once: ${JSON.stringify(await windows())}`);
  assert.equal(found[0].session, false, "the link opened in the session's window");

  // Once the session closes its window, links behave as before.
  await tool('session_window', { close: true });
  await settle();
  await openExternal(page('link-two'));
  await settle();
  found = await where('link-two');
  assert.equal(found.length, 1);
  assert.equal(found[0].session, false);
  console.log("ok: links from outside open in the user's window, the session's tabs in its own");
} finally {
  await client.close();
  socket.destroy();
  pages.close();
}
