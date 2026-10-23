/** One rate-limit window: `five_hour`, `seven_day` or a gateway's `spend_limit`. */
export type DashLimit = { kind: string; percent: number; resetsAt?: number }

/** The context window's fill and the account's rate-limit windows. */
export type DashUsage = {
  tokens?: number
  window: number
  percent?: number
  limits: DashLimit[]
}

/** One phase of a workflow run, counted over the agents started in it. */
export type DashPhase = {
  title: string
  total: number
  done: number
  failed: number
  running: number
  startedAt?: number
  endedAt?: number
}

export type DashRunStatus = 'running' | 'stalled'

export type DashRun = {
  runId: string
  name: string
  status: DashRunStatus
  startedAt?: number
  lastActivity?: number
  phases: DashPhase[]
  agents: number
  agentsDone: number
}

/** A subagent outside a workflow (the Agent tool, a teammate). */
export type DashAgent = {
  id: string
  description: string
  type: string
  status: string
  startedAt?: number
}

export type DashBoard = { at: number; runs: DashRun[]; agents: DashAgent[] }

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      usage: DashUsage | null
      board: DashBoard | null
      spawned: Record<string, number>
      isClosed: boolean
    }
  }
}
