/** This session's own Zen window, as zen-claude reported it; null when it has none. */
export type ZenWindow = { id: number; name: string | null }

declare module 'claude-code' {
  interface PluginState {
    'zen-window': { window: ZenWindow | null }
  }
}
