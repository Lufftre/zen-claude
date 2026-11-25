# zen-window: a Claude Code mod

Puts a link to the session's own Zen window at the end of the line under the
prompt: `⧉ Zen-fönster`, or the name Claude gave the window. Cmd-click it and
that window comes to the front.

The link is a plain hyperlink (it works outside fullscreen mode). A window in
agent Zen links to `zen-agents://session/<session>`: Zen Agents.app claims
that scheme, so macOS hands the link straight to it and the user's Zen never
comes forward, and the session outlasts its window's id when agent Zen
restarts. A window in the user's Zen links to
`http://zen-claude.localhost/window/<id>`, which Zen opens as the default
browser. Either way the extension closes that tab at once and brings the
window forward; only windows a session owns.

The mod learns the window from Claude's `session_window` and `tabs_context`
calls, and asks `tabs_context` once when a session starts. It draws what is
beneath it on that line and adds the link after it, so it shares the line with
other mods that do the same, such as Claude Board's.

Load it in every session with `CLAUDE_CODE_PLUGIN_DIRS=~/Code/Private/zen-claude/mod`
(colon-separated with other folders), or `claude --plugin-dir mod` from here.
