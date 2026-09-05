import { describe, expect, test } from 'bun:test'

import { createTimeline, summarizePullRequestProgress } from './timeline.mjs'

describe('createTimeline', () => {
  test('keeps the first sighting of a condition and ignores every later one', () => {
    const timeline = createTimeline(1_000)

    expect(timeline.mark('surface', 1_120)).toBe(120)
    expect(timeline.mark('surface', 1_400)).toBe(120)
    expect(timeline.at('surface')).toBe(120)
    expect(timeline.has('surface')).toBe(true)
  })

  test('reports a condition that never held as null, not as zero', () => {
    const timeline = createTimeline(1_000)

    expect(timeline.markIf('done', false, 1_050)).toBeNull()
    expect(timeline.at('done')).toBeNull()
    expect(timeline.has('done')).toBe(false)
    expect(timeline.markIf('done', true, 1_060)).toBe(60)
    expect(timeline.entries()).toEqual({ done: 60 })
  })

  test('times conditions independently, in the order they first held', () => {
    const timeline = createTimeline(500)

    timeline.markIf('tab', true, 600)
    timeline.markIf('code', false, 620)
    timeline.markIf('surface', true, 700)
    timeline.markIf('code', true, 900)

    expect(timeline.entries()).toEqual({ tab: 100, surface: 200, code: 400 })
  })
})

describe('summarizePullRequestProgress', () => {
  const events = [
    { t: 1_100, kind: 'metadata', fileCount: 4 },
    { t: 1_250, kind: 'files', files: 3, fileCount: 4 },
    { t: 1_310, kind: 'files', files: 1, fileCount: 4 },
    { t: 1_400, kind: 'done', fileCount: 4 }
  ]

  test('times metadata, the first file page and done from one stream', () => {
    expect(summarizePullRequestProgress(events, 1_000)).toEqual({
      metadataMs: 100,
      firstPageMs: 250,
      doneMs: 400,
      fileCount: 4,
      progressKinds: [
        { kind: 'metadata', ms: 100, count: 1 },
        { kind: 'files', ms: 250, count: 2 },
        { kind: 'done', ms: 400, count: 1 }
      ]
    })
  })

  test('records a kind it has never heard of and does not mistake it for a page', () => {
    const withReplace = [
      { t: 1_050, kind: 'metadata' },
      { t: 1_080, kind: 'checks' },
      { t: 1_120, kind: 'replace' },
      { t: 1_200, kind: 'files', files: 2 }
    ]

    const summary = summarizePullRequestProgress(withReplace, 1_000)

    expect(summary.firstPageMs).toBe(200)
    expect(summary.progressKinds.map((entry) => entry.kind)).toEqual(['metadata', 'checks', 'replace', 'files'])
    expect(summary.doneMs).toBeNull()
  })

  test('answers nulls for a stream that never arrived', () => {
    expect(summarizePullRequestProgress([], 1_000)).toEqual({
      metadataMs: null,
      firstPageMs: null,
      doneMs: null,
      fileCount: null,
      progressKinds: []
    })
    expect(summarizePullRequestProgress(undefined, 1_000).progressKinds).toEqual([])
  })

  test('reads the events in time order however they were recorded', () => {
    const shuffled = [events[3], events[1], events[0], events[2]]

    expect(summarizePullRequestProgress(shuffled, 1_000).metadataMs).toBe(100)
    expect(summarizePullRequestProgress(shuffled, 1_000).firstPageMs).toBe(250)
  })
})
