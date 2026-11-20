// A browser agent's terminal, opened by ⌘J beside a tab (agent.js). It shows the agent's terminal in Rex through the
// native host (agent/host.js in the repo), which starts the agent if the tab has none yet.
const params = new URLSearchParams(location.search);
const pageTab = Number(params.get("tab"));
const note = document.getElementById("note");
const say = (text) => ((note.textContent = text), note.classList.toggle("on", !!text));

const term = new Terminal({
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  theme: { background: "#1e1d1b", foreground: "#e8e5df", cursor: "#e0845a", selectionBackground: "#5a4a40" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));

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
