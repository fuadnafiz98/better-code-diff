import { describe, expect, it } from 'bun:test'

import { findHorusReviewRequest, formatHorusReviewUrl, parseHorusReviewUrl } from './horusUrl.js'

const pullRequestUrl = 'https://github.com/acme/app/pull/9'

describe('formatHorusReviewUrl', () => {
  it('omits the default open intent', () => {
    expect(formatHorusReviewUrl(pullRequestUrl)).toBe(
      'horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'
    )
  })

  it('marks a warmup so the app can fetch without focusing', () => {
    expect(formatHorusReviewUrl(`${pullRequestUrl}/files`, 'warmup')).toBe(
      'horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=warmup'
    )
  })

  it('rejects values that are not pull requests', () => {
    expect(formatHorusReviewUrl('https://github.com/acme/app/issues/9')).toBeNull()
  })
})

describe('parseHorusReviewUrl', () => {
  it('round-trips an open and a warmup link', () => {
    expect(parseHorusReviewUrl(formatHorusReviewUrl(pullRequestUrl) ?? '')).toEqual({
      url: pullRequestUrl,
      intent: 'open'
    })
    expect(parseHorusReviewUrl(formatHorusReviewUrl(pullRequestUrl, 'warmup') ?? '')).toEqual({
      url: pullRequestUrl,
      intent: 'warmup'
    })
  })

  it('accepts a bare GitHub pull-request URL', () => {
    expect(parseHorusReviewUrl(`${pullRequestUrl}/files?diff=split`)).toEqual({
      url: pullRequestUrl,
      intent: 'open'
    })
  })

  it('rejects unknown intents and non-review hosts', () => {
    expect(parseHorusReviewUrl('horus://review?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9&intent=delete'))
      .toBeNull()
    expect(parseHorusReviewUrl('horus://settings?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F9'))
      .toBeNull()
    expect(parseHorusReviewUrl('horus://review?url=https%3A%2F%2Fevil.example%2Fpull%2F9')).toBeNull()
  })
})

describe('findHorusReviewRequest', () => {
  it('prefers --horus-url over other arguments', () => {
    expect(findHorusReviewRequest([
      '/Applications/Electron.app/Contents/MacOS/Electron',
      'out/main/index.js',
      'https://github.com/other/repo/pull/1',
      '--horus-url',
      formatHorusReviewUrl(pullRequestUrl, 'warmup') ?? ''
    ])).toEqual({ url: pullRequestUrl, intent: 'warmup' })
  })

  it('reads an equals-form flag and a horus:// argument', () => {
    expect(findHorusReviewRequest([
      `--horus-url=${formatHorusReviewUrl(pullRequestUrl) ?? ''}`
    ])).toEqual({ url: pullRequestUrl, intent: 'open' })
    expect(findHorusReviewRequest([
      formatHorusReviewUrl(pullRequestUrl, 'warmup') ?? ''
    ])).toEqual({ url: pullRequestUrl, intent: 'warmup' })
  })

  it('accepts a GitHub URL dropped onto the app', () => {
    expect(findHorusReviewRequest([
      '/Applications/Horus.app/Contents/MacOS/Horus',
      `${pullRequestUrl}/files`
    ])).toEqual({ url: pullRequestUrl, intent: 'open' })
  })

  it('ignores electron helper flags', () => {
    expect(findHorusReviewRequest([
      'Electron',
      '--inspect=9229',
      '--remote-debugging-port=9222'
    ])).toBeNull()
  })
})
