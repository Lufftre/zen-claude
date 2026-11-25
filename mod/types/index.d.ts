/**
 * This session's own Zen window, as zen-claude reported it; null when it has none. session is set when the window is
 * in agent Zen: the link then names the session, which outlasts the window's id.
 */
export type ZenWindow = { id: number; name: string | null; session?: string | null }

declare module 'claude-code' {
  interface PluginState {
    'zen-window': { window: ZenWindow | null }
  }
}
