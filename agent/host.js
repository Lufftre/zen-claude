// The browser agent's native messaging host. Zen starts it when the extension's terminal page connects (one process
// per terminal), and it ends when the page closes. It starts the tab's agent, Claude Code in a window of Rex, and
// bridges that terminal to the page: Rex's output to the page, the page's typing and size to Rex.
//
// Rex documents its client protocol itself (GET /llms.txt on its socket). In short: a control WebSocket at
// /api/control (JSON requests and responses), and a data WebSocket at /api/data that streams the terminal's bytes after
// a binary handshake. The stream opens with a snapshot in Ghostty's binary format, which xterm.js can't read, so the
// screen is drawn from terminal.format as escape sequences instead and the stream is read from Rex's first own message.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const run = promisify(execFile);
const SOCKET = join(homedir(), "Library/Application Support/rex/server.sock");
const REX = process.env.REX_BIN ?? join(homedir(), "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex");
const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");
/** Where browser agents start, and the Rex session that holds them. */
const HOME = join(homedir(), "Library/Application Support/zen-claude/browser-agent");
const SESSION = "browser";

// Native messaging: each message is a 32-bit length, in the machine's byte order, then that much UTF-8 JSON.

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) break;
    const message = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
    input = input.subarray(4 + length);
    received(message).catch((e) => send({ type: "error", message: e.message }));
  }
});
process.stdin.on("end", () => end());

// Starting the agent.

// Zen, opened from the Dock, has macOS's bare PATH, and so does everything this host starts. Claude Code and its
// hooks need the user's own (Homebrew's node, ~/.local/bin): ask their shell once, as a terminal would set it up.
let userPath = null;
async function shellPath() {
  if (userPath) return userPath;
  try {
    const { stdout } = await run(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "\n%s" "$PATH"'], { timeout: 10000 });
    userPath = stdout.split("\n").pop().trim();
  } catch {}
  if (!userPath) userPath = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), process.env.PATH].filter(Boolean).join(":");
  return userPath;
}

async function rex(...args) {
  try {
    const { stdout } = await run(REX, args, { timeout: 15000, maxBuffer: 10_000_000 });
    return stdout;
  } catch (e) {
    throw new Error(`rex ${args[0]} failed: ${(e.stderr || e.message || "").trim()}`);
  }
}

/** What the agent is told: that it's a browser agent, for which tab, and how to look at it. */
function brief(tab) {
  return [
    `You are a browser agent, opened from the user's Zen browser beside one tab, which the user is looking at: tab ${tab.id}, "${tab.title}" at ${tab.url}.`,
    `The user will ask you about that page, or to do something in it. Look at it with the zen-browser tools, passing tabId ${tab.id}: get_page_text or read_page to read it, find to locate things, computer with action "screenshot" to see it, javascript_tool to inspect it closely. Act in it the same way.`,
    `Work in that tab, in the user's window: don't call session_window, and don't open tabs unless asked. The tab may have moved on since this was written; call tabs_context to see where it is now.`,
  ].join(" ");
}

/** Starts Claude Code for tab in a new window of the browser session, made on first use; gives its session and block. */
async function startAgent(tab) {
  mkdirSync(HOME, { recursive: true });
  const label = `Browser: ${tab.title || tab.url}`.slice(0, 48);
  const command = ["/usr/bin/env", `PATH=${await shellPath()}`, CLAUDE, "-n", label, "--append-system-prompt", brief(tab)];
  const { sessions } = JSON.parse(await rex("ls", "--json"));
  const found = sessions.find((s) => s.label === SESSION);
  if (!found) {
    const r = JSON.parse(await rex("new", SESSION, "-c", HOME, "--window", label, "--shell", "/bin/zsh", "--json", "--", ...command));
    return { session: r.session_id, block: r.initial_windows[0].block_ids[0] };
  }
  const r = JSON.parse(await rex("window", "new", "-s", found.session_id, label, "-c", HOME, "--shell", "/bin/zsh", "--json", "--", ...command));
  return { session: found.session_id, block: r.block_ids[0] };
}

/** Whether the block still runs in Rex: it goes when its program ends. */
async function alive(agent) {
  try {
    const { blocks } = JSON.parse(await rex("block", "ls", "-s", agent.session, "--json"));
    return blocks.some((b) => b.block_id === agent.block);
  } catch {
    return false;
  }
}

// Talking to Rex.

const open = (path, protocol) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://rex${path}`, protocol, { createConnection: () => net.connect(SOCKET), perMessageDeflate: false });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

let control, data, clientId = "";
let nextId = 0;
const waiting = new Map();

function call(method, payload) {
  const id = `b${++nextId}`;
  control.send(JSON.stringify({ type: "request", id, method, ...(payload && { payload }) }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

async function connectControl() {
  control = await open("/api/control", "rex.control.v1");
  const welcome = new Promise((resolve) => control.once("message", (m) => resolve(JSON.parse(String(m)))));
  control.send(JSON.stringify({ type: "hello", api_revision: 12, client: { kind: "app", platform: "macos", name: "Zen browser agent", version: "1" } }));
  clientId = (await welcome).client?.id ?? "";
  control.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.type === "response") {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.payload);
    } else if (msg.type === "event") event(msg.payload);
  });
  control.on("close", () => end("Rex closed the connection."));
}

let agent = null;
let size = null;

function event(e) {
  if (e?.type !== "session_event" || e.payload?.session_id !== agent?.session) return;
  const ev = e.payload.event;
  if (ev?.type === "block_closed" && ev.payload?.block_id === agent.block) end(null, true);
  if (ev?.type === "block_owner_changed" && ev.payload?.block_id === agent.block) owner = ev.payload.owner ?? null;
}

let owner = null;
const args = (extra) => ({ session_id: agent.session, block_id: agent.block, ...extra });

async function claim() {
  await call("session.own_block", { session_id: agent.session, block_ids: [agent.block], mode: "take" });
  owner = clientId;
  if (size) await call("com.superlogical.terminal.resize", args({ args: size })).catch(() => {});
}

// The page's messages.

async function received(m) {
  if (m.type === "resize") {
    size = { columns: m.cols, rows: m.rows };
    if (agent && control && owner === clientId) await call("com.superlogical.terminal.resize", args({ args: size })).catch(() => {});
  } else if (m.type === "open") await attach(m);
  else if (m.type === "input" && agent && control) type(m.data);
}

/** The page's open: its tab, the agent it had if any, and its size, so the screen is laid out for it before it's drawn. */
async function attach({ tab, agent: known, cols, rows }) {
  if (cols && rows) size = { columns: cols, rows };
  agent = known && (await alive(known)) ? { session: known.session, block: known.block } : await startAgent(tab);
  send({ type: "agent", session: agent.session, block: agent.block });
  await connectControl();
  await call("session.attach", { session_id: agent.session });
  await claim();
  // The screen now, as escape sequences, then the stream from after its snapshot.
  const screen = await call("com.superlogical.terminal.format", args({ args: {
    format: "vt", extra_cursor: true, extra_modes: true, extra_style: true, extra_charsets: true, extra_scrolling_region: true,
    extra_tabstops: true, extra_keyboard: true, extra_kitty_keyboard: true, extra_pwd: true, extra_hyperlink: true, extra_palette: true,
  } }));
  send({ type: "replay", data: "\x1bc" + (screen?.content ?? "") });
  const { ticket } = await call("data.connect", args({ data_ref_id: "terminal", subprotocol: "rex.data.terminal.v1" }));
  data = await open("/api/data", "rex.data.terminal.v1");
  data.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(ticket.replace(/-/g, "+").replace(/_/g, "/"), "base64")]));
  let nonce = null;
  let pending = Buffer.alloc(0);
  let marker = null;
  let inSnapshot = true;
  data.on("message", (raw, binary) => {
    const chunk = Buffer.from(raw);
    if (nonce === null) {
      if (chunk[0] === 0x82) return end(`Rex refused the terminal (reason 0x${chunk[1]?.toString(16)}).`);
      nonce = chunk.readBigUInt64LE(24);
      marker = Buffer.from(`\x1b_rex1;${nonce};`);
      return;
    }
    if (!binary) return;
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const at = pending.indexOf(marker);
      if (at < 0) {
        // Hold back what could be the start of a message cut off at the end of this chunk.
        let keep = 0;
        for (let n = Math.min(marker.length - 1, pending.length); n > 0; n--)
          if (pending.subarray(pending.length - n).equals(marker.subarray(0, n))) { keep = n; break; }
        if (!inSnapshot && pending.length > keep) send({ type: "output", data: pending.subarray(0, pending.length - keep).toString("base64") });
        pending = inSnapshot ? pending.subarray(Math.max(0, pending.length - marker.length + 1)) : pending.subarray(pending.length - keep);
        return;
      }
      if (!inSnapshot && at > 0) send({ type: "output", data: pending.subarray(0, at).toString("base64") });
      const st = pending.indexOf(Buffer.from([0x1b, 0x5c]), at + marker.length);
      if (st < 0) {
        pending = pending.subarray(at);
        return;
      }
      try {
        const msg = JSON.parse(pending.subarray(at + marker.length, st).toString("utf8"));
        if (msg.type === "resize") owner = msg.owner ?? null;
        // The terminal's colours, as Rex.app shows them: the page draws with the same ones.
        if (msg.type === "theme") send({ type: "theme", foreground: msg.foreground, background: msg.background, cursor: msg.cursor, palette: msg.palette ?? [] });
        if (msg.type === "child_exited") send({ type: "exit", code: msg.exit_code ?? 0 });
      } catch {}
      inSnapshot = false;
      pending = pending.subarray(st + 2);
    }
  });
  data.on("close", (code) => end(code === 4000 || code === 1000 ? null : `The terminal's stream ended (${code}).`, code === 4000));
}

// Typing. Rex's server answers the program's terminal queries itself, so xterm.js's own answers are left out: a second
// answer would reach the program as typed text. Writes go one at a time, as Rex doesn't keep separate writes in order.

const REPLIES = new RegExp([
  "\\x1b\\[[?>=][0-9;]*c", "\\x1b\\[[0-9]+;[0-9]+R", "\\x1b\\[\\?[0-9;]*R", "\\x1b\\[[0-9]n", "\\x1b\\[\\??[0-9;]*\\$y",
  "\\x1b\\[\\?[0-9]*u", "\\x1b\\[[0-9;]*t", "\\x1b\\][0-9]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "\\x1bP[^\\x1b]*\\x1b\\\\",
].join("|"), "g");

let outgoing = "";
let writing = false;
function type(text) {
  const kept = text.includes("\x1b") ? text.replace(REPLIES, "") : text;
  if (!kept) return;
  outgoing += kept;
  if (owner !== clientId) claim().catch(() => {});
  if (!writing) flush();
}
async function flush() {
  if (!outgoing) return void (writing = false);
  writing = true;
  const chunk = outgoing;
  outgoing = "";
  await call("com.superlogical.terminal.write", args({ args: { data: chunk } })).catch(() => {});
  flush();
}

// Ending: the page closed, or the agent did. The agent itself carries on in Rex unless its program ended.

let ended = false;
function end(problem, closed = false) {
  if (ended) return;
  ended = true;
  if (problem) send({ type: "error", message: problem });
  if (closed) send({ type: "closed" });
  try { data?.close(1000); } catch {}
  try { control?.close(1000); } catch {}
  setTimeout(() => process.exit(0), 100);
}
