import type { FsEntry } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cut, fmtDuration, fmtTokens, lookOf, progressOf } from '../hooks/register'
import { parseJournal, parseMeta, phasesOf } from '../hooks/workflows'

const PANE = {
  plugin: 'dashboard',
  component: 'Pane',
  requestId: 'dashboard',
  props: {
    title: 'Dashboard',
    isFocused: false,
    bodyColumns: 30,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the script meta gives the name and the phases in order', async () => {
  const meta = parseMeta(`export const meta = {
    name: 'review-changes',
    description: 'Review [the] diff',
    phases: [{ title: 'Review', detail: 'per dimension' }, { title: "Verify" }],
  }
  const x = [1, 2]`)

  expect(meta.name).toBe('review-changes')
  expect(meta.phases).toEqual(['Review', 'Verify'])
})

test('the journal counts each agent once, by its latest state', async () => {
  const journal = [
    '{"type":"launched"}',
    '{"type":"started","key":"k1","agentId":"a1","label":"bugs","phase":"Review"}',
    '{"type":"started","key":"k2","agentId":"a2","label":"perf","phase":"Review"}',
    '{"type":"result","key":"k1","agentId":"a1","result":"ok"}',
    '{"type":"started","key":"k3","agentId":"a3","label":"v","phase":"Verify"}',
    '{"type":"failed","key":"k3","agentId":"a3"}',
  ].join('\n')
  const agents = [...parseJournal(journal).values()]
  const phases = phasesOf(['Review', 'Verify', 'Fix'], agents)

  expect(phases.map(p => [p.title, p.done, p.running, p.failed, p.total])).toEqual([
    ['Review', 1, 1, 0, 2],
    ['Verify', 0, 0, 1, 1],
    ['Fix', 0, 0, 0, 0],
  ])
})

test('a run counts settled agents over all, a phase not started as one', async () => {
  const phase = (title: string, done: number, total: number, running = 0) => ({
    title,
    done,
    total,
    running,
    failed: 0,
  })
  const run = {
    runId: 'wf_build',
    name: 'build-feature',
    status: 'running' as const,
    phases: [phase('Spec', 1, 1), phase('Build', 1, 1), phase('Review', 0, 2, 2), phase('Fix', 0, 0)],
    agents: 4,
    agentsDone: 2,
  }

  expect(progressOf(run)).toEqual({ done: 2, total: 5 })
})

test('numbers read short', async () => {
  expect(fmtTokens(482_123)).toBe('482k')
  expect(fmtTokens(48_212)).toBe('48.2k')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtDuration(42_000)).toBe('42s')
  expect(fmtDuration(724_000)).toBe('12m 04s')
  expect(fmtDuration(3_900_000)).toBe('1h 05m')
  expect(cut('review-changes', 8)).toBe('review-…')
  expect(cut('short', 8)).toBe('short')
})

test('the pane shows the context window and the limits, on every surface', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'dash' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { tokens: 482_000, window: 1_000_000, percent: 48 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 37 },
      { kind: 'seven_day', percentUsed: 18.5 },
    ],
    changed: ['context', 'rateLimits'],
  })
  expect(statuses.at(-1)).toBe('ctx 48% (482k/1M) · 5h 37% · wk 18.5%')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^48%$/ }))?.text).toBe('48%')
    expect((await ui.find({ type: 'Text', text: /482k \/ 1M/ }))?.text).toBe('482k / 1M · 518k frei')
    expect((await ui.find({ type: 'Text', text: /^5h-Limit$/ }))?.text).toBe('5h-Limit')
    expect((await ui.find({ type: 'Text', text: /^18.5%$/ }))?.text).toBe('18.5%')
    expect((await ui.find({ type: 'Text', text: /Keine laufenden/ }))?.text).toBe('Keine laufenden Workflows.')
    await ui.unmount()
  }
})

test('the pane lists a running workflow by phase and leaves the finished one out, on every surface', async ($, on) => {
  const N = 1_800_000_000_000
  const S = '/h/.claude/projects/-p/s1'
  const file = (name: string, mtimeMs: number): FsEntry => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })
  const dir = (name: string): FsEntry => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  const lists: Record<string, FsEntry[]> = {
    [`${S}/subagents/workflows`]: [dir('wf_live-1')],
    [`${S}/workflows`]: [dir('scripts'), file('wf_done-2.json', N - 3_000_000)],
    [`${S}/workflows/scripts`]: [file('review-changes-wf_live-1.js', N - 300_000)],
    [`${S}/subagents/workflows/wf_live-1`]: [
      file('agent-a1.meta.json', N - 300_000),
      file('agent-a1.jsonl', N - 60_000),
      file('agent-a2.meta.json', N - 300_000),
      file('agent-a2.jsonl', N - 1_000),
      file('journal.jsonl', N - 60_000),
    ],
  }
  const reads: Record<string, string> = {
    [`${S}/workflows/scripts/review-changes-wf_live-1.js`]:
      "export const meta = { name: 'review-changes', phases: [{ title: 'Review' }, { title: 'Verify' }] }",
    [`${S}/subagents/workflows/wf_live-1/journal.jsonl`]: [
      '{"type":"started","key":"k1","agentId":"a1","label":"bugs","phase":"Review"}',
      '{"type":"started","key":"k2","agentId":"a2","label":"perf","phase":"Review"}',
      '{"type":"result","key":"k1","agentId":"a1","result":"ok"}',
    ].join('\n'),
    [`${S}/workflows/wf_done-2.json`]: JSON.stringify({
      workflowName: 'old-run',
      status: 'completed',
      startTime: N - 3_600_000,
      durationMs: 600_000,
      phases: [{ title: 'Build' }],
      workflowProgress: [
        { type: 'workflow_agent', phaseTitle: 'Build', state: 'done', startedAt: N - 3_600_000, durationMs: 500_000 },
      ],
    }),
  }

  const clock = mock.clock(on, { now: N })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  mock.env(on, { HOME: '/h' })
  on('command.register', () => ({ value: { command: 'dash' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/p' }))
  on('session.usage', () => ({ value: { startedAt: N, context: { window: 200_000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path === `${S}.jsonl` }))
  on('fs.list', (_, e) => ({ value: lists[e.path] ?? [] }))
  on('fs.read', (_, e) => {
    const text = reads[e.path]
    if (text === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: text }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  await clock.settle()
  expect(statuses.at(-1)).toBe('▶ review-changes · Review 1/2')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /^old-run$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^10m 00s$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^review-changes$/ }))?.text).toBe('review-changes')
    expect((await ui.find({ type: 'Text', text: /^ ● $/ }))?.text).toBe(' ● ')
    expect((await ui.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
    expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toMatch(/^ 1\/3 · 5m 0\ds$/)
    expect((await ui.find({ type: 'Text', text: /^5m 0\ds$/ }))?.text).toMatch(/^5m 0\ds$/)
    expect((await ui.find({ type: 'Text', text: /^Verify$/ }))?.text).toBe('Verify')
    expect((await ui.find({ type: 'Text', text: /^ · 1 aktiv$/ }))?.text).toBe(' · 1 aktiv')
    await ui.unmount()
  }
})

test('the /config colors map to the look, #282c34 by default', async () => {
  expect(lookOf({})).toEqual({ accent: 'claude', isTrafficLight: true, background: '#282c34', border: undefined })
  expect(lookOf({ background: 'transparent' }).background).toBeUndefined()
  expect(lookOf({ accent: 'lavendel', bars: 'akzent', background: 'dunkel', border: 'akzent' })).toEqual({
    accent: '#5e6ad2',
    isTrafficLight: false,
    background: '#17181a',
    border: '#5e6ad2',
  })
})

test(
  'the pane draws with a colored background and frame, on every surface',
  { options: { accent: 'lavendel', bars: 'akzent', background: 'dunkel', border: 'akzent' } },
  async ($, on) => {
    mock.clock(on, { now: 1_800_000_000_000 })
    on('ui.status', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'dash' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.session.measure({
      context: { tokens: 90_000, window: 200_000, percent: 45 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 91 }],
      changed: ['context', 'rateLimits'],
    })

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ type: 'Text', text: /^45%$/ }))?.text).toBe('45%')
      expect((await ui.find({ type: 'Text', text: /^91%$/ }))?.text).toBe('91%')
      await ui.unmount()
    }
  },
)
