import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import type { DashAgent, DashBoard, DashPhase, DashRun, DashUsage } from '../types'
import { newCaches, scanRuns } from './workflows'

const PANE = 'dashboard'
const TICK_MS = 2000
const IDLE_WRITE_MS = 30_000
const PANE_COLUMNS = 32
const COUNT_WIDTH = 6
const TIME_WIDTH = 9

const usageAtom = atom({ plugin: 'dashboard', key: 'usage' } as const, null)
const boardAtom = atom({ plugin: 'dashboard', key: 'board' } as const, null)
const spawnedAtom = atom({ plugin: 'dashboard', key: 'spawned' } as const, {})
const isClosedAtom = atom({ plugin: 'dashboard', key: 'isClosed' } as const, false)

type Dollar = EngineInterface

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h-Limit',
  seven_day: 'Weekly',
  spend_limit: 'Spend-Limit',
}

const STATUS_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' }

// The /config pickers (plugin.json userConfig): a name each, its color here.
const ACCENTS: Record<string, string> = {
  claude: 'claude',
  lavendel: '#5e6ad2',
  blau: '#3b82f6',
  cyan: '#06b6d4',
  grün: '#22c55e',
  pink: '#ec4899',
  grau: 'subtle',
}
const BACKGROUNDS: Record<string, string> = { '#282c34': '#282c34', dunkel: '#17181a', grau: '#292b2f' }

type Look = { accent: string; isTrafficLight: boolean; background?: string; border?: string }

export const lookOf = (options: PluginOptions): Look => {
  const accent = ACCENTS[String(options.accent)] ?? 'claude'

  return {
    accent,
    isTrafficLight: options.bars !== 'akzent',
    background: BACKGROUNDS[String(options.background ?? '#282c34')],
    border: options.border === 'akzent' ? accent : options.border === 'grau' ? 'subtle' : undefined,
  }
}

export const usageOf = (u: Pick<SessionUsage, 'context' | 'rateLimits'>): DashUsage => ({
  tokens: u.context.tokens,
  window: u.context.window,
  percent: u.context.percent,
  limits: u.rateLimits.map(l => ({
    kind: l.kind,
    percent: l.percentUsed,
    resetsAt: l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt) || undefined,
  })),
})

export const fmtTokens = (n: number): string => {
  if (n >= 1e6) {
    return `${Number((n / 1e6).toFixed(2))}M`
  }
  if (n >= 1e3) {
    return `${Number((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}k`
  }

  return String(n)
}

const pad = (n: number) => String(n).padStart(2, '0')

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ${pad(s % 60)}s`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return `${h}h ${pad(m % 60)}m`
  }

  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const tone = (percent: number) => (percent < 60 ? 'success' : percent < 85 ? 'warning' : 'error')

const isActive = (run: DashRun) => run.status === 'running' || run.status === 'stalled'

const phaseEnd = (phase: DashPhase, at: number) => phase.endedAt ?? at

export const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

/** The phase a run is in: the last one with an agent started. */
const currentPhase = (run: DashRun) => [...run.phases].reverse().find(p => p.total > 0)

/** A run's progress: settled agents over all agents, a phase not started yet counting as one. */
export const progressOf = (run: DashRun) =>
  run.phases.reduce(
    (sum, p) => ({ done: sum.done + p.done + p.failed, total: sum.total + Math.max(1, p.total) }),
    { done: 0, total: 0 },
  )

/** The line under the prompt: context, the limits, and what runs. */
export function statusOf(usage: DashUsage | null, runs: DashRun[]): string | undefined {
  const parts: string[] = []
  if (usage?.percent !== undefined && usage.tokens !== undefined) {
    parts.push(`ctx ${usage.percent}% (${fmtTokens(usage.tokens)}/${fmtTokens(usage.window)})`)
  }
  for (const limit of usage?.limits ?? []) {
    parts.push(`${STATUS_LABELS[limit.kind] ?? limit.kind} ${limit.percent}%`)
  }
  const active = runs.filter(isActive)
  const first = active[0]
  if (active.length > 1) {
    parts.push(`▶ ${active.length} Workflows`)
  } else if (first !== undefined) {
    const phase = currentPhase(first)
    parts.push(`▶ ${cut(first.name, 24)}${phase === undefined ? '' : ` · ${phase.title} ${phase.done}/${phase.total}`}`)
  }

  return parts.length === 0 ? undefined : parts.join(' · ')
}

let timer: Timer | undefined
let isBusy = false
let caches = newCaches()
let session: { id: string; dir: string } | undefined
let lastBoard = ''
let lastBoardAt = 0
let lastUsage = ''
let lastStatus: string | undefined
let currentUsage: DashUsage | null = null
let currentRuns: DashRun[] = []

function showStatus($: Dollar) {
  const text = statusOf(currentUsage, currentRuns)
  if (text !== lastStatus) {
    lastStatus = text
    try {
      $.ui.status(text)
    } catch {
      // A line not shown is shown with the next change.
      lastStatus = undefined
    }
  }
}

async function writeUsage($: Dollar, next: DashUsage) {
  currentUsage = next
  showStatus($)
  const json = JSON.stringify(next)
  if (json !== lastUsage) {
    lastUsage = json
    await update($, usageAtom, () => next)
  }
}

// ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<session id>; found by
// the transcript's name where the guess misses (a very long path is shortened).
async function sessionDir($: Dollar): Promise<string | undefined> {
  const id = await $.session.id()
  if (session?.id === id) {
    return session.dir
  }
  caches = newCaches()
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (config === undefined) {
    return undefined
  }
  const projects = `${config}/projects`
  const guess = `${projects}/${(await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')}`
  if (await $.fs.exists(`${guess}/${id}.jsonl`)) {
    session = { id, dir: `${guess}/${id}` }
    return session.dir
  }
  if (await $.fs.exists(guess)) {
    return `${guess}/${id}`
  }
  for (const project of await $.fs.list(projects).catch(() => [])) {
    if (project.kind === 'dir' && (await $.fs.exists(`${projects}/${project.name}/${id}.jsonl`))) {
      session = { id, dir: `${projects}/${project.name}/${id}` }
      return session.dir
    }
  }

  return undefined
}

async function tick($: Dollar) {
  if (isBusy) {
    return
  }
  isBusy = true
  try {
    const at = await $.clock.now()
    await writeUsage($, usageOf(await $.session.usage()))

    const dir = await sessionDir($)
    const runs = dir === undefined ? [] : await scanRuns($, dir, at, caches)
    currentRuns = runs
    showStatus($)
    const spawned = await read($, spawnedAtom)
    const agents: DashAgent[] = (await $.agent.list()).map(a => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status,
      startedAt: spawned[a.id],
    }))

    const json = JSON.stringify({ runs, agents })
    const isLive = runs.some(isActive) || agents.some(a => a.status === 'running')
    if (isLive || json !== lastBoard || at - lastBoardAt >= IDLE_WRITE_MS) {
      lastBoard = json
      lastBoardAt = at
      const board: DashBoard = { at, runs, agents }
      await update($, boardAtom, () => board)
    }
  } finally {
    isBusy = false
  }
}

function open($: Dollar) {
  return $.ui.open({ id: PANE, title: 'Dashboard', columns: PANE_COLUMNS })
}

export const register: Register = (on, options) => {
  const look = lookOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash',
      description: 'Dashboard: Context-Window, 5h- und Weekly-Limit, Workflows mit Phasen',
    })
    if (!(await read($, isClosedAtom))) {
      void open($)
    }
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    void tick($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    await update($, isClosedAtom, () => false)
    const opened = await open($)

    return { text: opened.isPlaced ? 'Dashboard geöffnet.' : `Dashboard wartet: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, isClosedAtom, () => true)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await writeUsage($, usageOf(e)).catch(() => undefined)

    return next(e)
  })

  // A plain subagent's start time: $.agent.list() does not carry one.
  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    const { agentId } = ran
    if (e.workflow === undefined && e.resume === undefined && agentId !== undefined) {
      await update($, spawnedAtom, map =>
        Object.fromEntries([...Object.entries(map), [agentId, startedAt]].slice(-200)),
      ).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const board = await read($, boardAtom)
    const at = board?.at ?? (await $.clock.now())
    const inner = e.props.bodyColumns - (look.border === undefined ? 0 : 4)
    const barWidth = Math.max(8, Math.min(48, inner))
    const fill = (percent: number) => (look.isTrafficLight ? tone(percent) : look.accent)

    const bar = (
      percent: number | undefined,
      width = barWidth,
      color = percent === undefined ? undefined : fill(percent),
    ) => {
      const filled =
        percent === undefined ? 0 : Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

      return (
        <Text mono>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)}</Text>
        </Text>
      )
    }

    // Label and percent above the bar, the detail dim beneath it.
    const meter = (label: string, percent: number | undefined, detail: string) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexShrink={1}>
            <Text weight="bold" wrap="truncate-end">
              {label}
            </Text>
          </Box>
          <Text color={percent === undefined ? undefined : fill(percent)} tabular>
            {percent === undefined ? '–' : `${percent}%`}
          </Text>
        </Box>
        {bar(percent)}
        {detail !== '' && (
          <Text dimColor tabular wrap="truncate-end">
            {detail}
          </Text>
        )}
      </Box>
    )

    const meters = () => {
      if (usage === null) {
        return <Text dimColor>Noch keine Messung.</Text>
      }
      const { tokens, window, percent } = usage
      const context =
        tokens === undefined
          ? `${fmtTokens(window)} Fenster`
          : `${fmtTokens(tokens)} / ${fmtTokens(window)} · ${fmtTokens(Math.max(0, window - tokens))} frei`

      return (
        <Box flexDirection="column" rowGap={1}>
          {meter('Context', tokens === undefined ? undefined : percent, context)}
          {usage.limits.map(limit =>
            meter(
              LIMIT_LABELS[limit.kind] ?? limit.kind,
              limit.percent,
              limit.resetsAt === undefined ? '' : `Reset in ${fmtDuration(limit.resetsAt - at)}`,
            ),
          )}
          {usage.limits.length === 0 && <Text dimColor>Limits: noch keine Daten.</Text>}
        </Box>
      )
    }

    const section = (title: string, note?: string) => (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{'─'.repeat(Math.max(1, inner))}</Text>
        <Box flexDirection="row">
          <Text weight="bold">{title}</Text>
          {note !== undefined && <Text dimColor>{` · ${note}`}</Text>}
        </Box>
      </Box>
    )

    // Icon and title, then done/started agents and the phase's time in fixed columns.
    const phaseRow = (phase: DashPhase) => {
      const isWaiting = phase.total === 0
      const [icon, color] = isWaiting
        ? ['○', 'inactive']
        : phase.running > 0
          ? ['●', look.accent]
          : phase.failed > 0
            ? ['✗', 'error']
            : phase.done === phase.total
              ? ['✓', 'success']
              : ['■', 'warning']

      return (
        <Box flexDirection="row">
          <Box flexDirection="row" flexGrow={1} flexShrink={1}>
            <Text color={color}>{` ${icon} `}</Text>
            <Text wrap="truncate-end" dimColor={isWaiting}>
              {phase.title}
            </Text>
          </Box>
          {!isWaiting && (
            <Box width={COUNT_WIDTH} justifyContent="flex-end">
              <Text tabular color={phase.running > 0 ? look.accent : undefined}>
                {`${phase.done}/${phase.total}`}
              </Text>
            </Box>
          )}
          {!isWaiting && (
            <Box width={TIME_WIDTH} justifyContent="flex-end">
              <Text dimColor tabular>
                {phase.startedAt === undefined ? '–' : fmtDuration(phaseEnd(phase, at) - phase.startedAt)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const runBlock = (run: DashRun) => {
      const { done, total } = progressOf(run)
      const time = run.startedAt === undefined ? '–' : fmtDuration(at - run.startedAt)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text weight="bold" wrap="truncate-end">
                {run.name}
              </Text>
            </Box>
            <Text tabular>{` ${done}/${total} · ${time}`}</Text>
          </Box>
          {bar(total === 0 ? 0 : (done / total) * 100, barWidth, look.isTrafficLight ? 'success' : look.accent)}
          {run.status === 'stalled' && run.lastActivity !== undefined && (
            <Text color="warning">{` keine Aktivität seit ${fmtDuration(at - run.lastActivity)}`}</Text>
          )}
          {run.phases.map(phaseRow)}
        </Box>
      )
    }

    const agentRow = (agent: DashAgent) => (
      <Box flexDirection="row">
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          <Text color={look.accent}> ● </Text>
          <Text wrap="truncate-end">{agent.description}</Text>
        </Box>
        <Box width={TIME_WIDTH} justifyContent="flex-end">
          <Text dimColor tabular>
            {agent.startedAt === undefined ? '' : fmtDuration(at - agent.startedAt)}
          </Text>
        </Box>
      </Box>
    )

    const runs = board?.runs ?? []
    const agents = (board?.agents ?? []).filter(a => a.status === 'running')
    const frame =
      look.border === undefined ? {} : { borderStyle: 'round', borderColor: look.border, paddingX: 1 }
    // Docked, the engine lays its own gray under the pane: the color fills every row of it.
    const toBottom =
      look.background !== undefined && e.props.placement === 'dock' ? { minHeight: e.props.scroll.bodyRows } : {}

    return (
      <Box flexDirection="column" backgroundColor={look.background} {...toBottom} {...frame}>
        {meters()}
        {section('Workflows', runs.length === 0 ? undefined : `${runs.length} aktiv`)}
        {runs.length === 0 ? (
          <Text dimColor>Keine laufenden Workflows.</Text>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {runs.map(runBlock)}
          </Box>
        )}
        {agents.length > 0 && section('Subagents', `${agents.length} aktiv`)}
        {agents.length > 0 && <Box flexDirection="column">{agents.map(agentRow)}</Box>}
      </Box>
    )
  })
}
