// A browser agent's terminal, opened by ⌘J beside a tab (agent.js). It shows the agent's terminal in Rex through the
// native host (agent/host.js in the repo), which starts the agent if the tab has none yet.
const params = new URLSearchParams(location.search);
const pageTab = Number(params.get("tab"));
const note = document.getElementById("note");
const say = (text) => ((note.textContent = text), note.classList.toggle("on", !!text));

// Rex's colours, as Rex.app shows a terminal until Rex says otherwise (a theme message): Claude Code picks its
// colours for them, so drawing with others makes it look off.
const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
const BASE = {
  background: "#1d1f21", foreground: "#c5c8c6", cursor: "#c5c8c6", selectionBackground: "#4b5056",
  ...Object.fromEntries(NAMES.map((n, i) => [n, "#" + ["1d1f21", "cc6666", "b5bd68", "f0c674", "81a2be", "b294bb", "8abeb7", "c5c8c6",
    "666666", "d54e53", "b9ca4a", "e7c547", "7aa6da", "c397d8", "70c0b1", "eaeaea"][i]])),
};
const hex = (c) => (c ? (c.startsWith("#") ? c : "#" + c) : undefined);

const term = new Terminal({
  // SF Mono isn't open to web pages; Menlo is, with the box and block characters Claude Code draws with.
  fontFamily: "Menlo, Monaco, monospace",
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  theme: BASE,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
// Unicode 11 widths, closer to Ghostty's than xterm.js's default, so symbols such as ⏺ and ⏵ take the room they do in Rex.
const unicode = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = "11";
// WebGL draws faster than the DOM, and draws box and block characters itself, so lines and the logo join up.
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  term.loadAddon(webgl);
} catch (e) {
  console.warn("Browser agent: no WebGL, drawing with the DOM", e);
}

function theme(m) {
  const t = { ...BASE };
  if (m.background) t.background = hex(m.background);
  if (m.foreground) t.foreground = t.cursor = hex(m.foreground);
  if (m.cursor) t.cursor = hex(m.cursor);
  const extended = [];
  for (const entry of m.palette ?? []) {
    const [i, c] = entry.split("=");
    const n = Number(i);
    if (n < 16) t[NAMES[n]] = hex(c);
    else if (n < 256) extended[n - 16] = hex(c);
  }
  if (extended.length) t.extendedAnsi = extended;
  term.options.theme = t;
  document.body.style.background = t.background;
}

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
let port;

async function start() {
  const tab = await browser.tabs.get(pageTab).catch(() => null);
  if (!tab) return say("The page this agent was for has closed.");
  document.title = `Agent · ${tab.title}`;
  fit.fit();
  port = browser.runtime.connectNative("zen_claude_agent");
  port.onDisconnect.addListener(() => say(port.error ? `The agent's host stopped: ${port.error.message}` : "The agent's connection closed. ⌘J twice opens it again."));
  port.onMessage.addListener((m) => {
    if (m.type === "agent") browser.runtime.sendMessage({ type: "agent", pageTab, agent: { session: m.session, block: m.block } });
    else if (m.type === "replay") term.write(m.data);
    else if (m.type === "theme") theme(m);
    else if (m.type === "output") term.write(bytes(m.data));
    else if (m.type === "exit") say(`Claude exited (${m.code}). ⌘J opens a new agent.`);
    else if (m.type === "closed") (browser.runtime.sendMessage({ type: "agent", pageTab, agent: null }), say("The agent ended. ⌘J opens a new one."));
    else if (m.type === "error") say(m.message);
  });
  const known = params.get("session") && params.get("block") ? { session: params.get("session"), block: params.get("block") } : null;
  port.postMessage({ type: "open", tab: { id: tab.id, url: tab.url, title: tab.title }, agent: known, cols: term.cols, rows: term.rows });
  term.onData((data) => port.postMessage({ type: "input", data }));
  term.onResize(({ cols, rows }) => port.postMessage({ type: "resize", cols, rows }));
  term.focus();
}

// The split settles its width a moment after the tab opens: wait for the size to hold, so the screen is laid out for it.
let settle;
new ResizeObserver(() => {
  clearTimeout(settle);
  settle = setTimeout(() => (port ? fit.fit() : start()), port ? 50 : 250);
}).observe(document.getElementById("term"));
window.addEventListener("focus", () => term.focus());
