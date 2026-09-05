import { describe, expect, test } from 'bun:test'

import { horusLaunchPlan } from './horus'

const deepLink = 'horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F717&intent=open'

describe('horusLaunchPlan', () => {
  test('reaches a running Horus through the scheme instead of relaunching it', () => {
    expect(horusLaunchPlan({ deepLink, intent: 'open', running: true }))
      .toEqual({ kind: 'scheme', args: [deepLink] })
  })

  test('warms a running Horus in the background', () => {
    expect(horusLaunchPlan({ deepLink, intent: 'warmup', running: true }))
      .toEqual({ kind: 'scheme', args: ['-g', deepLink] })
  })

  test('never starts Horus to warm it', () => {
    expect(horusLaunchPlan({ deepLink, intent: 'warmup', running: false })).toEqual({ kind: 'none' })
  })

  test('launches a cold Horus with the URL on the command line', () => {
    expect(horusLaunchPlan({ deepLink, intent: 'open', running: false })).toEqual({
      kind: 'launch',
      args: ['-a', 'Horus', '--args', `--horus-url=${deepLink}`]
    })
  })
})
