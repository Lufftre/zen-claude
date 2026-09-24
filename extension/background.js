/* Claude for Zen – background page.
 * Keeps a WebSocket to the local MCP server and executes tool calls. */

const VERSION = browser.runtime.getManifest().version;
const RECONNECT_MS = 2000;
const BUSY_RECONNECT_MS = 10000;
const MAX_NETWORK_ENTRIES = 500;

const state = {
  enabled: true,
  port: 8765,
  ws: null,
  connected: false,
  busy: false,
  trustedEnabled: true, // use the privileged experiment when the browser allows it
  trustedAvailable: null,
  activity: [], // recent tool calls for the popup
};

// ---------------------------------------------------------------------------
// Connection

async function loadSettings() {
  const s = await browser.storage.local.get({ enabled: true, port: 8765, trustedEnabled: true });
  state.enabled = s.enabled;
  state.port = s.port;
  state.trustedEnabled = s.trustedEnabled;
}

// Firefox exponentially delays reconnects after failed WebSocket attempts (up to a minute), so probe with a plain
// HTTP request first (the server answers 426) and only open the socket once something is listening.
async function serverListening() {
  try {
    await fetch(`http://127.0.0.1:${state.port}/`, { cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

async function connect() {
  if (!state.enabled || state.ws) return;
  if (!(await serverListening())) return scheduleReconnect();
  if (!state.enabled || state.ws) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${state.port}`);
  } catch {
    return scheduleReconnect();
  }
  state.ws = ws;
  ws.onopen = async () => {
    state.connected = true;
    state.busy = false;
    updateBadge();
    const info = await browser.runtime.getBrowserInfo().catch(() => ({}));
    ws.send(JSON.stringify({ type: 'hello', version: VERSION, browser: `${info.name || ''} ${info.version || ''}`.trim() }));
  };
  ws.onmessage = (e) => onRequest(ws, e.data);
  ws.onclose = (e) => {
    if (state.ws && state.ws !== ws) return; // superseded by a newer socket
    state.ws = null;
    state.connected = false;
    state.busy = e.code === 4001; // another browser holds the connection
    updateBadge();
    scheduleReconnect(state.busy ? BUSY_RECONNECT_MS : RECONNECT_MS);
  };
  ws.onerror = () => {}; // onclose follows
}

let reconnectTimer = null;
function scheduleReconnect(delay = RECONNECT_MS) {
  if (reconnectTimer || !state.enabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const ws = state.ws;
  state.ws = null;
  state.connected = false;
  ws?.close();
  updateBadge();
}

function updateBadge() {
  const [text, color] = !state.enabled ? ['off', '#888'] : state.connected ? ['', '#2e9d5b'] : state.busy ? ['…', '#b07d2b'] : ['!', '#c0392b'];
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setTitle({ title: `Claude for Zen – ${statusText()}` });
}

function statusText() {
  if (!state.enabled) return 'disabled';
  if (state.connected) return 'connected';
  if (state.busy) return 'another browser is connected';
  return 'waiting for MCP server';
}

async function onRequest(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const { id, method, params = {} } = msg;
  const entry = { time: Date.now(), method, summary: summarize(method, params), ok: null };
  state.activity.unshift(entry);
  state.activity.length = Math.min(state.activity.length, 30);
  let reply;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    reply = { id, result: await handler(params) };
    entry.ok = true;
  } catch (err) {
    reply = { id, error: err?.message || String(err) };
    entry.ok = false;
    entry.error = reply.error;
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

function summarize(method, p) {
  if (method === 'computer') return [p.action, p.ref, p.coordinate?.join(','), p.text].filter(Boolean).join(' ');
  return p.url || p.query || p.ref || (p.code && p.code.slice(0, 60)) || '';
}

// ---------------------------------------------------------------------------
// Helpers

async function resolveTab(tabId) {
  if (tabId != null) return browser.tabs.get(tabId);
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return tab;
}

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/;

const CONTENT_TIMEOUT_MS = 30000;

function sendMessageWithTimeout(tabId, message) {
  return Promise.race([
    browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
    sleep(CONTENT_TIMEOUT_MS).then(() => {
      throw new Error(`The page did not respond within ${CONTENT_TIMEOUT_MS / 1000}s (it may be blocked by a dialog or busy).`);
    }),
  ]);
}

async function sendToContent(tabId, message) {
  try {
    return await sendMessageWithTimeout(tabId, message);
  } catch (err) {
    if (!NO_RECEIVER.test(err.message)) throw err;
  }
  // Tab was opened before the extension loaded, or is still loading: inject and retry.
  try {
    await browser.tabs.executeScript(tabId, { file: 'content.js', runAt: 'document_start' });
  } catch (err) {
    const tab = await browser.tabs.get(tabId);
    throw new Error(`Cannot access this page (${tab.url}): ${err.message}. Privileged pages like about: and addons.mozilla.org are off-limits to extensions.`);
  }
  return sendMessageWithTimeout(tabId, message);
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeTab(t) {
  return `${t.active ? '*' : ' '} [${t.id}] ${t.title || '(untitled)'}\n      ${t.url}`;
}

async function ensureActive(tab) {
  if (!tab.active) {
    await browser.tabs.update(tab.id, { active: true });
    await sleep(150);
  }
}

async function capture(tab, { rect, scale = 1 } = {}) {
  await ensureActive(tab);
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 80,
    scale, // Firefox: 1 => one image pixel per CSS pixel, so coordinates map directly
    ...(rect ? { rect } : {}),
  });
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' };
}

async function viewportInfo(tabId) {
  try { return await sendToContent(tabId, { type: 'viewport' }); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Network log (per tab, reset on top-level navigation)

const network = new Map(); // tabId -> entries

function netEntry(details) {
  if (details.tabId < 0) return null;
  if (details.type === 'main_frame' && details.frameId === 0) network.set(details.tabId, []);
  let list = network.get(details.tabId);
  if (!list) network.set(details.tabId, (list = []));
  return list;
}

const pendingRequests = new Map(); // requestId -> entry

browser.webRequest.onBeforeRequest.addListener((d) => {
  const list = netEntry(d);
  if (!list) return;
  const entry = { method: d.method, url: d.url, type: d.type, start: d.timeStamp, status: 'pending' };
  list.push(entry);
  if (list.length > MAX_NETWORK_ENTRIES) list.shift();
  pendingRequests.set(d.requestId, entry);
}, { urls: ['<all_urls>'] });

browser.webRequest.onCompleted.addListener((d) => {
  const entry = pendingRequests.get(d.requestId);
  if (!entry) return;
  pendingRequests.delete(d.requestId);
  entry.status = d.statusCode;
  entry.ms = Math.round(d.timeStamp - entry.start);
  entry.fromCache = d.fromCache;
}, { urls: ['<all_urls>'] });

browser.webRequest.onErrorOccurred.addListener((d) => {
  const entry = pendingRequests.get(d.requestId);
  if (!entry) return;
  pendingRequests.delete(d.requestId);
  entry.status = `failed: ${d.error}`;
  entry.ms = Math.round(d.timeStamp - entry.start);
}, { urls: ['<all_urls>'] });

browser.tabs.onRemoved.addListener((tabId) => network.delete(tabId));

// ---------------------------------------------------------------------------
// Tool handlers

const CONTENT_ACTIONS = new Set([
  'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag',
  'type', 'key', 'scroll', 'scroll_to',
]);

// ---------------------------------------------------------------------------
// Trusted input (Zen and other builds that allow WebExtension Experiments)

async function checkTrustedAvailable() {
  if (state.trustedAvailable === null) {
    try {
      state.trustedAvailable = !!browser.trustedInput && (await browser.trustedInput.status()).available;
    } catch {
      state.trustedAvailable = false;
    }
  }
  return state.trustedAvailable;
}

async function trustedInput() {
  return state.trustedEnabled && (await checkTrustedAvailable()) ? browser.trustedInput : null;
}

const KEY_ALIASES = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', page_up: 'PageUp', page_down: 'PageDown', home: 'Home', end: 'End',
  insert: 'Insert',
};

function parseModifiers(str = '') {
  const m = {};
  for (const part of str.toLowerCase().split('+').filter(Boolean)) {
    if (part === 'ctrl' || part === 'control') m.ctrlKey = true;
    else if (part === 'shift') m.shiftKey = true;
    else if (part === 'alt' || part === 'option') m.altKey = true;
    else if (['meta', 'cmd', 'command', 'super', 'win'].includes(part)) m.metaKey = true;
  }
  return m;
}

function parseKeyCombo(combo) {
  const parts = combo.split('+');
  const raw = parts.pop();
  const mods = parseModifiers(parts.join('+'));
  let key = KEY_ALIASES[raw.toLowerCase()] || (/^f\d{1,2}$/i.test(raw) ? raw.toUpperCase() : raw);
  if (key.length === 1 && mods.shiftKey) key = key.toUpperCase();
  return { key, ...mods };
}

// Wait until the tab's content process accepts input; see probePoint in content.js.
async function ensureInputReady(ti, tab, preferred) {
  const point = await sendToContent(tab.id, { type: 'probePoint', preferred });
  if (!point) return;
  for (let i = 0; i < 30; i++) {
    // Alternate by a pixel: a mousemove to the pointer's current position is ignored.
    await ti.mouse(tab.id, [{ type: 'mousemove', x: point.x + (i % 2), y: point.y }]);
    await sleep(100);
    if (await sendToContent(tab.id, { type: 'probeSeen' })) return;
  }
  throw new Error('The tab did not start accepting input within 3s.');
}

async function trustedAction(ti, tab, p) {
  await ensureActive(tab);
  if (p.action !== 'scroll_to') await ensureInputReady(ti, tab, p.coordinate || p.start_coordinate);
  const mods = parseModifiers(p.modifiers);
  const locate = (args) => sendToContent(tab.id, { type: 'locate', ...args });
  const at = (t) => `(${Math.round(t.x)}, ${Math.round(t.y)})`;
  switch (p.action) {
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      if (!p.ref && !p.coordinate) throw new Error('Provide coordinate or ref.');
      const t = await locate({ ref: p.ref, coordinate: p.coordinate });
      const button = p.action === 'right_click' ? 2 : 0;
      const count = { double_click: 2, triple_click: 3 }[p.action] || 1;
      const events = [{ type: 'mousemove', x: t.x, y: t.y, ...mods }];
      for (let c = 1; c <= count; c++) {
        events.push({ type: 'mousedown', x: t.x, y: t.y, button, buttons: button === 2 ? 2 : 1, clickCount: c, ...mods });
        // The OS widget normally generates contextmenu; synthesized input has to send it explicitly.
        if (button === 2) events.push({ type: 'contextmenu', x: t.x, y: t.y, button, buttons: 2, ...mods });
        events.push({ type: 'mouseup', x: t.x, y: t.y, button, buttons: 0, clickCount: c, ...mods });
      }
      await ti.mouse(tab.id, events);
      await sleep(300);
      const closed = await ti.dismissPopups(tab.id).catch(() => []);
      const note = closed.length
        ? ` A native ${closed.join(' and ')} opened and was closed (it can't be seen or used from here${closed.includes('select dropdown') ? '; use form_input for <select>' : ''}).`
        : '';
      return `${p.action} at ${at(t)} on ${t.description}.${note}`;
    }
    case 'hover': {
      const t = await locate({ ref: p.ref, coordinate: p.coordinate });
      await ti.mouse(tab.id, [{ type: 'mousemove', x: t.x, y: t.y, ...mods }]);
      return `Hovering ${t.description} at ${at(t)}.`;
    }
    case 'left_click_drag': {
      if (!p.start_coordinate || !p.coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate.');
      const [x0, y0] = p.start_coordinate;
      const [x1, y1] = p.coordinate;
      const events = [
        { type: 'mousemove', x: x0, y: y0, ...mods },
        { type: 'mousedown', x: x0, y: y0, button: 0, buttons: 1, ...mods },
      ];
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        events.push({ type: 'mousemove', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, buttons: 1, ...mods });
      }
      events.push({ type: 'mouseup', x: x1, y: y1, button: 0, buttons: 0, ...mods });
      await ti.mouse(tab.id, events);
      return `Dragged from (${x0}, ${y0}) to (${x1}, ${y1}).`;
    }
    case 'type': {
      if (typeof p.text !== 'string') throw new Error('type needs text.');
      if (p.ref) await sendToContent(tab.id, { type: 'focus', ref: p.ref });
      await ti.text(tab.id, p.text);
      const focused = await sendToContent(tab.id, { type: 'focused' });
      return `Typed ${p.text.length} character(s); focus is on ${focused}.`;
    }
    case 'key': {
      if (!p.text) throw new Error('key needs text, e.g. "Enter" or "ctrl+a".');
      if (p.ref) await sendToContent(tab.id, { type: 'focus', ref: p.ref });
      const combos = p.text.trim().split(/\s+/);
      await ti.keys(tab.id, combos.map(parseKeyCombo));
      await sleep(150);
      const closed = await ti.dismissPopups(tab.id).catch(() => []);
      const focused = await sendToContent(tab.id, { type: 'focused' }).catch(() => 'the page');
      const note = closed.length ? ` A native ${closed.join(' and ')} was left open and has been closed.` : '';
      return `Pressed ${combos.join(', ')}; focus is on ${focused}.${note}`;
    }
    case 'scroll': {
      const t = await locate({ ref: p.ref, coordinate: p.coordinate });
      const dir = p.scroll_direction || 'down';
      const px = (dir === 'up' || dir === 'left' ? -1 : 1) * (p.scroll_amount ?? 3) * 100;
      const vertical = dir === 'up' || dir === 'down';
      await ti.wheel(tab.id, t.x, t.y, vertical ? 0 : px, vertical ? px : 0);
      await sleep(300);
      const vp = await viewportInfo(tab.id);
      return `Sent a ${Math.abs(px)}px wheel scroll ${dir} at ${at(t)} over ${t.description}.${vp ? ` Page scroll is now (${vp.scrollX}, ${vp.scrollY}).` : ''}`;
    }
  }
  return null; // not handled here (e.g. scroll_to)
}

const handlers = {
  async tabs_context({ all_windows }) {
    const windows = all_windows
      ? await browser.windows.getAll({ populate: true, windowTypes: ['normal'] })
      : [await browser.windows.getLastFocused({ populate: true })];
    const blocks = windows.map((w) => {
      const header = `Window ${w.id} (${w.state}, ${w.width}x${w.height}${w.focused ? ', focused' : ''}):`;
      return `${header}\n${w.tabs.map(describeTab).join('\n')}`;
    });
    return { text: `(* = active tab)\n${blocks.join('\n\n')}` };
  },

  async tabs_create({ url }) {
    const tab = await browser.tabs.create({ url: url || undefined, active: true });
    if (url) await waitForLoad(tab.id);
    const t = await browser.tabs.get(tab.id);
    return { text: `Created tab ${t.id}: ${t.title}\n${t.url}` };
  },

  async tabs_close({ tabId }) {
    await browser.tabs.remove(tabId);
    return { text: `Closed tab ${tabId}` };
  },

  async tabs_activate({ tabId }) {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { text: `Activated tab ${tabId}: ${tab.title}` };
  },

  async navigate({ url, tabId }) {
    const tab = await resolveTab(tabId);
    const loaded = waitForLoad(tab.id);
    if (url === 'back') await browser.tabs.goBack(tab.id);
    else if (url === 'forward') await browser.tabs.goForward(tab.id);
    else {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      await browser.tabs.update(tab.id, { url });
    }
    await loaded;
    const t = await browser.tabs.get(tab.id);
    return { text: `Tab ${t.id} loaded: ${t.title}\n${t.url}` };
  },

  async computer(p) {
    const tab = await resolveTab(p.tabId);
    switch (p.action) {
      case 'screenshot': {
        const image = await capture(tab);
        const vp = await viewportInfo(tab.id);
        const text = vp
          ? `Screenshot of tab ${tab.id}, viewport ${vp.width}x${vp.height} CSS px, scrolled to (${vp.scrollX}, ${vp.scrollY}).`
          : `Screenshot of tab ${tab.id}.`;
        return { image, text };
      }
      case 'zoom': {
        const [x0, y0, x1, y1] = p.region || [];
        if (x1 <= x0 || y1 <= y0) throw new Error('zoom needs region [x0, y0, x1, y1] with x1 > x0 and y1 > y0.');
        const vp = await viewportInfo(tab.id);
        const image = await capture(tab, {
          rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
          scale: Math.max(2, vp?.dpr || 1),
        });
        return { image, text: `Zoomed region [${x0}, ${y0}, ${x1}, ${y1}].` };
      }
      case 'wait': {
        const s = Math.min(Math.max(p.duration ?? 1, 0), 30);
        await sleep(s * 1000);
        return { text: `Waited ${s}s.` };
      }
      default: {
        if (!CONTENT_ACTIONS.has(p.action)) throw new Error(`Unknown action: ${p.action}`);
        const ti = await trustedInput();
        if (ti) {
          try {
            const text = await trustedAction(ti, tab, p);
            if (text != null) return { text };
          } catch (err) {
            if (/message manager disconnected|Receiving end|context unloaded/i.test(err.message)) {
              return { text: `${p.action} dispatched; the page navigated.` };
            }
            throw err;
          }
        }
        let result;
        try {
          result = await sendToContent(tab.id, { type: 'action', ...p });
        } catch (err) {
          // A click that navigates can tear down the content script before it replies.
          if (/message manager disconnected|Receiving end|context unloaded/i.test(err.message)) {
            return { text: `${p.action} dispatched; the page navigated.` };
          }
          throw err;
        }
        if (/click|key/.test(p.action)) await sleep(250); // let the page react
        return { text: result };
      }
    }
  },

  async read_page({ tabId, ...opts }) {
    const tab = await resolveTab(tabId);
    const text = await sendToContent(tab.id, { type: 'readPage', ...opts });
    return { text: `Tab ${tab.id}: ${tab.title}\n${tab.url}\n\n${text}` };
  },

  async find({ tabId, query }) {
    const tab = await resolveTab(tabId);
    return { text: await sendToContent(tab.id, { type: 'find', query }) };
  },

  async form_input({ tabId, ref, value }) {
    const tab = await resolveTab(tabId);
    return { text: await sendToContent(tab.id, { type: 'formInput', ref, value }) };
  },

  async get_page_text({ tabId, max_chars }) {
    const tab = await resolveTab(tabId);
    const text = await sendToContent(tab.id, { type: 'pageText', max_chars });
    return { text: `${tab.title}\n${tab.url}\n\n${text}` };
  },

  async javascript_tool({ tabId, code }) {
    const tab = await resolveTab(tabId);
    const wrap = (body) => `(async () => ${body})().then(
      (v) => { try { return { ok: v === undefined ? 'undefined' : JSON.stringify(v, null, 2) ?? String(v) } }
               catch { return { ok: String(v) } } },
      (e) => ({ error: (e && (e.stack || e.message)) || String(e) }))`;
    let results;
    try {
      results = await browser.tabs.executeScript(tab.id, { code: wrap(`(\n${code}\n)`) });
    } catch {
      // Not a single expression – run as a function body.
      results = await browser.tabs.executeScript(tab.id, { code: wrap(`{\n${code}\n}`) });
    }
    const r = results?.[0];
    if (r?.error) throw new Error(r.error);
    return { text: r?.ok ?? 'undefined' };
  },

  async read_console_messages({ tabId, ...opts }) {
    const tab = await resolveTab(tabId);
    return { text: await sendToContent(tab.id, { type: 'console', ...opts }) };
  },

  async read_network_requests({ tabId, url_pattern, limit = 100, clear }) {
    const tab = await resolveTab(tabId);
    let list = network.get(tab.id) || [];
    if (url_pattern) {
      let re;
      try { re = new RegExp(url_pattern, 'i'); } catch { re = null; }
      list = list.filter((e) => (re ? re.test(e.url) : e.url.includes(url_pattern)));
    }
    const shown = list.slice(-limit);
    if (clear) network.set(tab.id, []);
    if (!shown.length) return { text: 'No network requests recorded for this tab.' };
    const lines = shown.map((e) => `${e.method} ${e.status} ${e.type} ${e.ms ?? '-'}ms ${e.url}`);
    return { text: `${shown.length} of ${list.length} request(s):\n${lines.join('\n')}` };
  },

  async split_view({ tabIds, layout = 'vertical' }) {
    if (!browser.trustedInput) throw new Error('Split view needs Zen with the trustedInput experiment enabled.');
    await browser.trustedInput.splitView(tabIds, layout);
    await sleep(300);
    return { text: layout === 'unsplit' ? 'Split view closed.' : `Tabs ${tabIds.join(', ')} are now split (${layout}).` };
  },

  async resize_window({ tabId, width, height }) {
    const tab = await resolveTab(tabId);
    const win = await browser.windows.update(tab.windowId, { width: Math.round(width), height: Math.round(height), state: 'normal' });
    return { text: `Window resized to ${win.width}x${win.height}.` };
  },
};

// ---------------------------------------------------------------------------
// Popup API

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (sender.tab) return; // only the popup
  if (msg.type === 'getState') {
    await checkTrustedAvailable();
    return {
      enabled: state.enabled, port: state.port, connected: state.connected, busy: state.busy, status: statusText(),
      trustedEnabled: state.trustedEnabled, trustedAvailable: state.trustedAvailable, activity: state.activity,
    };
  }
  if (msg.type === 'setEnabled') {
    state.enabled = msg.enabled;
    await browser.storage.local.set({ enabled: state.enabled });
    state.enabled ? connect() : disconnect();
    updateBadge();
  }
  if (msg.type === 'setTrusted') {
    state.trustedEnabled = msg.enabled;
    await browser.storage.local.set({ trustedEnabled: state.trustedEnabled });
  }
  if (msg.type === 'setPort') {
    state.port = Number(msg.port) || 8765;
    await browser.storage.local.set({ port: state.port });
    disconnect();
    connect();
  }
});

loadSettings().then(() => {
  updateBadge();
  connect();
});
