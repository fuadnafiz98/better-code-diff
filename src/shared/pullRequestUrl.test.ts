import { describe, expect, it } from 'bun:test'

import {
  describeGitHubPullRequest,
  extractGitHubPullRequestUrl,
  githubRepoSlugFromPullRequestUrl,
  normalizeGitHubPullRequestUrl
} from './pullRequestUrl.js'

describe('normalizeGitHubPullRequestUrl', () => {
  it('keeps the stable pull-request selector', () => {
    expect(normalizeGitHubPullRequestUrl('https://github.com/pierrecomputer/pierre/pull/123/files'))
      .toBe('https://github.com/pierrecomputer/pierre/pull/123')
  })

  it('rejects non-GitHub and unsafe values', () => {
    expect(normalizeGitHubPullRequestUrl('https://example.com/owner/repo/pull/42')).toBeNull()
    expect(normalizeGitHubPullRequestUrl('https://user@github.com/owner/repo/pull/42')).toBeNull()
    expect(normalizeGitHubPullRequestUrl('https://github.com/owner/repo/issues/42')).toBeNull()
  })
})

describe('extractGitHubPullRequestUrl', () => {
  it('finds a URL inside copied Slack or markdown text', () => {
    expect(extractGitHubPullRequestUrl(
      'please review https://github.com/acme/app/pull/9/files?diff=split thanks'
    )).toBe('https://github.com/acme/app/pull/9')
    expect(extractGitHubPullRequestUrl('[PR](https://github.com/acme/app/pull/9)'))
      .toBe('https://github.com/acme/app/pull/9')
  })

  it('returns null when nothing in the text is a pull request', () => {
    expect(extractGitHubPullRequestUrl('https://github.com/acme/app/issues/9')).toBeNull()
    expect(extractGitHubPullRequestUrl('not a url')).toBeNull()
  })
})

describe('describeGitHubPullRequest', () => {
  it('names the repository and number', () => {
    expect(describeGitHubPullRequest('https://www.github.com/Acme/App/pull/12/commits'))
      .toEqual({
        owner: 'Acme',
        repository: 'App',
        number: 12,
        url: 'https://github.com/Acme/App/pull/12'
      })
  })
})

describe('githubRepoSlugFromPullRequestUrl', () => {
  it('lowercases the owner and repository', () => {
    expect(githubRepoSlugFromPullRequestUrl('https://github.com/Acme/App/pull/12'))
      .toBe('acme/app')
  })

  it('returns null when the text is not a pull request', () => {
    expect(githubRepoSlugFromPullRequestUrl('https://github.com/acme/app/issues/12')).toBeNull()
  })
})
