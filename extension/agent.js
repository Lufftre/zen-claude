// ⌘J: a browser agent beside the page. The first ⌘J on a tab starts Claude Code for it in Rex and shows its terminal
// in a Zen split beside the tab (agent/terminal.html); ⌘J again puts the terminal away, and the agent keeps running in
// Rex, so the next ⌘J brings back the same one. The agent is told which tab it's for, and looks at it with the
// zen-browser tools. A tab's agent is remembered for as long as the browser runs.

const TERMINAL = browser.runtime.getURL("agent/terminal.html");
const agents = new Map(); // page tab id -> { session, block }
const terminals = new Map(); // page tab id -> terminal tab id

const pageOf = (tab) => (tab.url?.startsWith(TERMINAL) ? Number(new URL(tab.url).searchParams.get("tab")) : null);

async function closeTerminal(page) {
  const term = terminals.get(page);
  terminals.delete(page);
  if (term != null) await browser.tabs.remove(term).catch(() => {});
  await browser.tabs.update(page, { active: true }).catch(() => {});
}

async function toggleAgent() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const page = pageOf(tab) ?? tab.id;
  if (pageOf(tab) != null || terminals.has(page)) return closeTerminal(page);
  const known = agents.get(page);
  const url = `${TERMINAL}?tab=${page}${known ? `&session=${encodeURIComponent(known.session)}&block=${encodeURIComponent(known.block)}` : ""}`;
  const term = await browser.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, active: false });
  terminals.set(page, term.id);
  if (browser.trustedInput?.splitView) await browser.trustedInput.splitView([page, term.id], "vertical").catch(() => {});
  await browser.tabs.update(term.id, { active: true });
}

// Zen keeps ⌘J for its Downloads window, and the browser's own keys win over an extension's: free it.
browser.trustedInput?.freeShortcut?.("j", "accel").then(
  (freed) => freed.length && console.log(`Browser agent: freed ⌘J from ${freed.join(", ")}`),
  (e) => console.error("Browser agent: couldn't free ⌘J:", e),
);

browser.commands.onCommand.addListener((command) => {
  if (command === "browser-agent") toggleAgent().catch((e) => console.error("Browser agent:", e));
});

browser.runtime.onMessage.addListener((m, sender) => {
  if (m?.type !== "agent" || !sender.url?.startsWith(TERMINAL)) return;
  if (m.agent) agents.set(m.pageTab, m.agent);
  else agents.delete(m.pageTab);
});

browser.tabs.onRemoved.addListener((id) => {
  // The page closed: its terminal goes too (the agent stays in Rex). Its terminal closed: forget that it's open.
  if (terminals.has(id)) closeTerminal(id).catch(() => {});
  for (const [page, term] of terminals) if (term === id) terminals.delete(page);
  agents.delete(id);
});
