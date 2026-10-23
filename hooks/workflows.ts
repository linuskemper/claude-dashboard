import type { EngineInterface, FsEntry } from 'claude-code'

import type { DashPhase, DashRun } from '../types'

// Where Claude Code keeps a session's workflow runs, under
// ~/.claude/projects/<project>/<session>/:
//   subagents/workflows/<runId>/journal.jsonl   started/result/failed per agent, written live
//   subagents/workflows/<runId>/agent-<id>.*     meta.json at the agent's start, jsonl per message
//   workflows/scripts/<name>-<runId>.js          the script, written at launch (meta.phases)
//   workflows/<runId>.json                       the run's record, written once it ends (it is then left out)

type AgentState = 'running' | 'done' | 'failed'
type AgentRow = { phase: string; state: AgentState; startedAt?: number; endedAt?: number }

export type ScriptMeta = { name?: string; phases: string[] }
export type Caches = { metas: Map<string, ScriptMeta> }

const NO_PHASE = '(ohne Phase)'
const STALL_MS = 20 * 60 * 1000
const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/.source

export const newCaches = (): Caches => ({ metas: new Map() })

/** Reads `meta.name` and the phase titles out of a script's `export const meta = { ... }`. */
export function parseMeta(script: string): ScriptMeta {
  const at = script.indexOf('export const meta')
  if (at < 0) {
    return { phases: [] }
  }
  const text = script.slice(at, at + 20_000)
  const name = new RegExp(`\\bname\\s*:\\s*${STRING}`).exec(text)?.[2]
  const phasesAt = text.search(/\bphases\s*:\s*\[/)
  if (phasesAt < 0) {
    return { name, phases: [] }
  }
  const open = text.indexOf('[', phasesAt)
  let depth = 0
  let end = text.length
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') {
      depth += 1
    } else if (text[i] === ']' && --depth === 0) {
      end = i
      break
    }
  }
  const titles = text.slice(open, end).matchAll(new RegExp(`\\btitle\\s*:\\s*${STRING}`, 'g'))

  return { name, phases: [...titles].map(m => m[2] ?? '') }
}

type JournalRow = { type?: string; key?: string; agentId?: string; phase?: string | null }

/** The run's agents by journal key: the latest attempt's id, its phase and whether it settled. */
export function parseJournal(text: string): Map<string, { agentId: string; phase: string; state: AgentState }> {
  const byKey = new Map<string, { agentId: string; phase: string; state: AgentState }>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    let row: JournalRow
    try {
      row = JSON.parse(line) as JournalRow
    } catch {
      continue
    }
    const key = row.key ?? row.agentId
    if (key === undefined) {
      continue
    }
    if (row.type === 'started') {
      byKey.set(key, { agentId: row.agentId ?? key, phase: row.phase || NO_PHASE, state: 'running' })
    } else if (row.type === 'result' || row.type === 'failed') {
      const known = byKey.get(key)
      if (known) {
        known.state = row.type === 'result' ? 'done' : 'failed'
      }
    }
  }

  return byKey
}

const numbers = (values: (number | undefined)[]) =>
  values.filter((v): v is number => typeof v === 'number' && v > 0)

/** Phases in the script's order, then any the journal names that the script did not. */
export function phasesOf(order: string[], agents: AgentRow[]): DashPhase[] {
  const titles = [...order]
  for (const agent of agents) {
    if (!titles.includes(agent.phase)) {
      titles.push(agent.phase)
    }
  }

  return titles.map(title => {
    const mine = agents.filter(a => a.phase === title)
    const running = mine.filter(a => a.state === 'running').length
    const starts = numbers(mine.map(a => a.startedAt))
    const ends = numbers(mine.map(a => a.endedAt))

    return {
      title,
      total: mine.length,
      done: mine.filter(a => a.state === 'done').length,
      failed: mine.filter(a => a.state === 'failed').length,
      running,
      startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
      endedAt: running === 0 && ends.length > 0 ? Math.max(...ends) : undefined,
    }
  })
}

/** A run still going: agents from the journal, their times from the files' modification times. */
export function liveRun(runId: string, meta: ScriptMeta, journal: string, entries: FsEntry[], now: number): DashRun {
  const mtime = new Map(entries.map(e => [e.name, e.mtimeMs]))
  const agents: AgentRow[] = [...parseJournal(journal).values()].map(a => ({
    phase: a.phase,
    state: a.state,
    startedAt: mtime.get(`agent-${a.agentId}.meta.json`) || mtime.get(`agent-${a.agentId}.jsonl`),
    endedAt: a.state === 'running' ? undefined : mtime.get(`agent-${a.agentId}.jsonl`),
  }))
  const lastActivity = Math.max(0, ...entries.map(e => e.mtimeMs))
  const isStalled = lastActivity > 0 && now - lastActivity > STALL_MS
  const starts = numbers(agents.map(a => a.startedAt))

  return {
    runId,
    name: meta.name ?? runId,
    status: isStalled ? 'stalled' : 'running',
    startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
    lastActivity: lastActivity || undefined,
    phases: phasesOf(meta.phases, agents),
    agents: agents.length,
    agentsDone: agents.filter(a => a.state !== 'running').length,
  }
}

async function listOr($: EngineInterface, path: string): Promise<FsEntry[]> {
  return $.fs.list(path).catch((): FsEntry[] => [])
}

/** The session's workflow runs that have not ended, newest first. */
export async function scanRuns($: EngineInterface, sessionDir: string, now: number, caches: Caches): Promise<DashRun[]> {
  const liveDir = `${sessionDir}/subagents/workflows`
  const doneDir = `${sessionDir}/workflows`
  const [live, done] = await Promise.all([listOr($, liveDir), listOr($, doneDir)])
  const finished = new Set(
    done.filter(f => f.kind === 'file' && /^wf_.+\.json$/.test(f.name)).map(f => f.name.slice(0, -5)),
  )
  const ids = live.filter(d => d.kind === 'dir' && d.name.startsWith('wf_') && !finished.has(d.name)).map(d => d.name)
  let scripts: FsEntry[] | undefined
  const runs: DashRun[] = []

  for (const runId of ids) {
    let meta = caches.metas.get(runId)
    if (meta === undefined) {
      scripts ??= await listOr($, `${doneDir}/scripts`)
      const script = scripts.find(s => s.name.endsWith(`-${runId}.js`))
      if (script) {
        const parsed = parseMeta(await $.fs.read(`${doneDir}/scripts/${script.name}`).catch(() => ''))
        meta = { ...parsed, name: script.name.slice(0, -(runId.length + 4)) || parsed.name }
        caches.metas.set(runId, meta)
      }
    }
    const dir = `${liveDir}/${runId}`
    const [entries, journal] = await Promise.all([
      listOr($, dir),
      $.fs.read(`${dir}/journal.jsonl`).catch(() => ''),
    ])
    runs.push(liveRun(runId, meta ?? { phases: [] }, journal, entries, now))
  }

  return runs.sort((a, b) => (b.startedAt ?? now) - (a.startedAt ?? now))
}
