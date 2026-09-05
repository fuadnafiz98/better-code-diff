import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { AgentRequestSubject, RepositorySnapshot } from '../shared/contracts.js'

import {
  agentReviewPaths,
  formatAgentReviewInstructions,
  prepareAgentReviewContext,
  rememberedAgentReviewFrom,
  writeAgentReviewBundle
} from './agentReviewBundle.js'

const snapshot = (root: string): RepositorySnapshot => ({
  root,
  name: 'app',
  kind: 'git',
  branch: 'main',
  head: 'desk-head',
  paths: ['src/auth.py'],
  statuses: []
})

const subject = (root: string): AgentRequestSubject => ({
  tabId: 'patch:https://github.com/acme/app/pull/7:base:head',
  repositoryRoot: root,
  repositoryName: 'app',
  source: 'patch',
  baseOid: 'base-oid',
  headOid: 'head-oid',
  pullRequestUrl: 'https://github.com/acme/app/pull/7',
  workingBranch: 'main'
})

const remembered = rememberedAgentReviewFrom({
  kind: 'github',
  selector: '7',
  baseOid: 'base-oid',
  headOid: 'head-oid',
  commitId: 'head-oid',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 7,
    title: 'Add session management',
    url: 'https://github.com/acme/app/pull/7',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'octocat' },
    headRefName: 'feature',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-09-04T00:00:00Z',
    additions: 4,
    deletions: 1,
    changedFiles: 1
  },
  files: [{ path: 'src/auth.py', additions: 4, deletions: 1 }],
  patch: 'diff --git a/src/auth.py b/src/auth.py\n+session_id\n',
  omittedFiles: [],
  expectedFileCount: 1
})

describe('writeAgentReviewBundle', () => {
  test('writes the patch beside the checkout and excludes it from git status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-review-bundle-'))
    await mkdir(join(root, '.git', 'info'), { recursive: true })

    const written = await writeAgentReviewBundle(root, remembered, snapshot(root))
    const paths = agentReviewPaths(root)

    expect(written.patchPath).toBe(paths.patch)
    expect(await readFile(paths.patch, 'utf8')).toContain('+session_id')
    expect(await readFile(paths.brief, 'utf8')).toContain('#7 Add session management')
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.horus/')
  })

  test('excludes .horus from a linked gitdir used by worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-review-worktree-'))
    const gitDir = await mkdtemp(join(tmpdir(), 'horus-review-gitdir-'))
    await writeFile(join(root, '.git'), `gitdir: ${gitDir}\n`)

    await writeAgentReviewBundle(root, remembered, snapshot(root))

    expect(await readFile(join(gitDir, 'info', 'exclude'), 'utf8')).toContain('.horus/')
    expect(await readFile(agentReviewPaths(root).patch, 'utf8')).toContain('+session_id')
  })
})

describe('prepareAgentReviewContext', () => {
  test('points the agent at the local patch and forbids GitHub fetches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horus-review-prepare-'))
    await mkdir(join(root, '.git'), { recursive: true })

    const context = await prepareAgentReviewContext({
      snapshot: snapshot(root),
      subject: subject(root),
      remembered,
      cached: null
    })

    expect(context).toContain(agentReviewPaths(root).patch)
    expect(context).toContain('Do not fetch remotes')
    expect(context).toContain('src/auth.py (+4/-1)')
    expect(context).toContain('mermaid')
  })

  test('still forbids network search when the patch is missing', () => {
    const context = formatAgentReviewInstructions({
      subject: subject('/repo-a'),
      review: null,
      snapshot: snapshot('/repo-a'),
      patchPath: null,
      briefPath: null
    })

    expect(context).toContain('Do not fetch remotes')
    expect(context).toContain('No local patch file is available')
    expect(context).toContain('git fetch')
  })
})
