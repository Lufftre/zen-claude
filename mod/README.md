# zen-window: a Claude Code mod

Puts a link to the session's own Zen window at the end of the line under the
prompt: `⧉ Zen-fönster`, or the name Claude gave the window. Cmd-click it and
that window comes to the front.

The link is a plain hyperlink (it works outside fullscreen mode), to
`http://zen-claude.localhost/window/<id>`. Zen, as the default browser, opens
it, and the extension closes that tab at once and focuses the window; only
windows a session owns.

The mod learns the window from Claude's `session_window` and `tabs_context`
calls, and asks `tabs_context` once when a session starts. It draws what is
beneath it on that line and adds the link after it, so it shares the line with
other mods that do the same, such as Claude Board's.

Load it in every session with `CLAUDE_CODE_PLUGIN_DIRS=~/Code/Private/zen-claude/mod`
(colon-separated with other folders), or `claude --plugin-dir mod` from here.
