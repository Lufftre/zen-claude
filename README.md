# Claude for Zen

Lets Claude Code control Zen (or any Firefox-based browser), much like Claude in Chrome.

```
Claude Code ──stdio/MCP──▶ server/index.js ──ws://127.0.0.1:8765──▶ extension (background.js)
                                                                        │ tabs / captureVisibleTab / webRequest
                                                                        ▼
                                                                    content.js (DOM tree, refs, input synthesis)
```

- The first MCP server process binds the WebSocket hub. Servers for additional Claude sessions connect to it as
  peers and have their requests relayed, and a peer takes over the port if the hub exits.
- The hub only accepts the extension from a `moz-extension://` origin. Browsers always send an Origin header, so web
  pages can't pretend to be the extension or a peer.
- If several browsers run the extension, the first one to connect is used; the others wait (popup shows "another
  browser is connected").

## Setup

```sh
npm install
claude mcp add --scope user zen-browser -- node "$PWD/server/index.js"
```

### Load the extension in Zen

Trusted (browser-level) input uses a privileged WebExtension Experiment. Zen permits these; official Firefox does not.
In `about:config` set:

| Pref | Value | Why |
| --- | --- | --- |
| `extensions.experiments.enabled` | `true` | allow the `trustedInput` experiment |
| `xpinstall.signatures.required` | `false` | allow the unsigned, permanent install (not needed for temporary loading) |

Then either:

- **Permanent:** `npm run ext:build` and open `dist/claude-for-zen.xpi` in Zen (or *about:addons → ⚙ → Install
  Add-on From File…*).
- **Until restart:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `extension/manifest.json`.
  (Without the experiments pref, Zen refuses to load it temporarily.)

**Official Firefox:** use `dist/claude-for-firefox.zip` (experiment stripped; page-level input only). Firefox release
only installs signed add-ons, so sign it as unlisted:
`npx web-ext sign --source-dir <unzipped dir> --channel unlisted --api-key … --api-secret …`.

**Dev:** `npm run ext:run` launches Zen with a throwaway profile, the prefs above and the extension loaded.

The toolbar icon shows the state: no badge = connected, `!` = waiting for the MCP server, `…` = another browser
holds the connection, `off` = disabled. The popup has on/off switches for control and trusted input, the port, and a
log of recent tool calls.

## Tools

| Tool | What it does |
| --- | --- |
| `tabs_context` | Windows (state, size) and their tabs |
| `tabs_create` / `tabs_close` / `tabs_activate` | Tab management |
| `navigate` | Load a URL (or `back` / `forward`) and wait for load |
| `computer` | `screenshot`, `zoom`, clicks, `hover`, `left_click_drag`, `type`, `key`, `scroll`, `scroll_to`, `wait` |
| `read_page` | Accessibility-style tree with `ref_N` handles (`interactive` or `all`) |
| `find` | Elements matching a text description, with refs and positions |
| `form_input` | Set inputs, selects, checkboxes by ref |
| `get_page_text` | Readable text of the page |
| `javascript_tool` | Run JS in the page (content-script context; `window.wrappedJSObject` for page globals) |
| `read_console_messages` | Captured console output and uncaught errors |
| `read_network_requests` | Requests since the last top-level navigation |
| `resize_window` | Resize the window |

Screenshots are captured at one image pixel per CSS pixel, so screenshot coordinates can be passed straight to
`computer`.

## Trusted input

With the experiment active, clicks, typing, keys, scrolling, hover and drags are dispatched by
`extension/experiments/trustedInput/parent.js` in the parent process. It uses Mozilla's own `EventUtils.js` (shipped
with the browser's remote agent) on the browser window at the tab's position. The events take the same route as real
OS input, so the page sees `isTrusted: true`, `navigator.userActivation` becomes active (pop-ups, clipboard, fullscreen
work), native text editing, selection and key bindings apply, and editors that ignore synthetic events work. It works
while Zen is in the background.

Caveats:

- The target tab is activated first, since input goes to what's visible.
- When another app is in front, Zen's window is made active *inside Gecko only* (via `focusmanager.testmode`, set just
  for the raise and then restored), so keys have somewhere to go without bringing Zen to the front.
- Gecko drops input until a tab's content process reports it's ready (after loads and process-switching
  navigations). Before the first trusted input in each document, the extension probes with mousemoves until one
  arrives.
- Native `<select>` dropdowns and the browser context menu are browser UI that screenshots can't show. If a click opens
  one it is closed again and reported; use `form_input` for `<select>`.
- `cmd/ctrl+Q` and `cmd/ctrl+W` are refused. Other browser shortcuts (e.g. `cmd+T`) do take effect, like for a user.
- It relies on Gecko internals (`EventUtils.js`, `window.synthesizeMouseEvent`) that can change between Zen updates.
  If it breaks, untick *Trusted input* in the popup to fall back to page-level events.
- The experiment runs with full browser privileges; the WebSocket only listens on 127.0.0.1 and only accepts the
  extension's own origin.

Without the experiment (official Firefox, or the popup toggle off), input is synthesized by the content script:
`isTrusted` is false, gestures that need user activation are blocked, and a few sites ignore the events. In both modes,
cross-origin iframes are opaque to `read_page`/`find`, and privileged pages (`about:*`, addons.mozilla.org) are
off-limits.

## Testing

`scripts/test-instance.sh` launches Zen with a throwaway profile and a copy of the extension on port 8766, so it
doesn't collide with your real browser (which holds 8765). Point test clients at it with `ZEN_CLAUDE_PORT=8766`:

```sh
(cd test && python3 -m http.server 8931 &)
scripts/test-instance.sh &
ZEN_CLAUDE_PORT=8766 node test/smoke.js '[["navigate",{"url":"http://localhost:8931/page.html"}],["read_page",{}]]'
ZEN_CLAUDE_PORT=8766 node test/diag.mjs '[{"action":"left_click","coordinate":[170,115]},{"action":"type","text":"abc"}]'
```

`test/smoke.js` runs a list of tool calls. `test/diag.mjs` opens a fresh tab of the test page, runs `computer` actions,
and prints which events reached the page (with `isTrusted`), then closes the tab.
