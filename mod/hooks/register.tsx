import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ZenWindow } from '../types'

// This session's own Zen window (zen-claude's session_window), as a link at the end of the line under the prompt.
// The terminal isn't in fullscreen mode, so no clicks reach the mod: it is a plain hyperlink (Cmd-click), like
// Claude Board's. A window in agent Zen (Zen Agents.app) is linked as zen-agents://session/<session>: macOS hands that
// straight to Zen Agents, which claims the scheme, so the user's Zen doesn't come forward first, and a session outlasts
// its window's id when agent Zen restarts. A window in the user's Zen is http://zen-claude.localhost/window/<id>, which
// Zen opens as the default browser. Either way the extension closes that tab at once and brings the window forward.
//
// Living with other mods on that line (Claude Board draws the whole line): this hook draws what is beneath it and
// adds the link after it, so it composes whether it runs above or beneath another mod that does the same.
const win = atom({ plugin: 'zen-window', key: 'window' } as const, null as ZenWindow | null)

const SERVER = 'zen-browser'
const OWN = /This session's window is (\d+)(?: in agent Zen \(session ([\w-]+)\))?/
const LISTED = /Window (\d+) \([^)]*this session's window/
const AGENT_ZEN = /^In agent Zen \(session ([\w-]+)\)/m
const href = (w: ZenWindow) =>
  w.session ? `zen-agents://session/${w.session}` : `http://zen-claude.localhost/window/${w.id}`

// The window a tabs_context answer marks as this session's, and its session when it's in agent Zen.
const listed = (text: string): Pick<ZenWindow, 'id' | 'session'> | null => {
  const id = LISTED.exec(text)?.[1]
  return id ? { id: Number(id), session: AGENT_ZEN.exec(text)?.[1] ?? null } : null
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map(c => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')
    : ''

export const register: Register = on => {
  // After a restart or reload, find a window the session already has (tabs_context opens none).
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    const answer = await $.mcp.call(SERVER, 'tabs_context', {}).catch(() => null)
    const found = listed(textOf(answer?.content))
    if (found) await update($, win, w => ({ ...found, name: w?.id === found.id ? w.name : null }))
    return done
  })

  // Claude opens, names or closes the window.
  on('tool.call', { tool: 'mcp__zen-browser__session_window' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const input = e as unknown as { close?: boolean; name?: string }
    if (input.close) await update($, win, () => null)
    else {
      const [, id, session] = OWN.exec(ran.text ?? '') ?? []
      if (id) {
        await update($, win, w => ({
          id: Number(id),
          session: session ?? null,
          name: input.name?.trim() || (w?.id === Number(id) ? w.name : null),
        }))
      }
    }
    return ran
  })

  // A listing that marks this session's window keeps the id current.
  on('tool.call', { tool: 'mcp__zen-browser__tabs_context' }, async ($, e, next) => {
    const ran = await next(e)
    const found = ran.deny === undefined ? listed(ran.text ?? '') : null
    if (found) await update($, win, w => ({ ...found, name: w?.id === found.id ? w.name : null }))
    return ran
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    const w = await read($, win)
    if (!w) return below
    const { Box, Link, Text } = $.ui.resolve(e)
    return (
      <Box>
        {below}
        <Text dimColor>
          {'   ⧉ '}
          <Link href={href(w)}>{w.name ?? 'Zen-fönster'}</Link>
        </Text>
      </Box>
    )
  })
}
