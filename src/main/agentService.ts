import { access } from 'node:fs/promises'
import { constants as fileConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  query as queryClaude,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionMode
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentApprovalDecision,
  AgentModelCatalog,
  AgentProvider,
  AgentProviderStatus,
  AgentProviderStatuses,
  AgentStreamEvent
} from '../shared/contracts.js'

import { CodexAppServer } from './codexAppServer.js'
import {
  AGENT_READ_ONLY_TOOLS,
  AGENT_REVIEW_TOOLS,
  createAgentTextReader,
  interpretAgentLine,
  parseAgentAskRequest,
  type AgentAskRequest
} from './agentRequest.js'

const CLAUDE_CANDIDATES = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
] as const
const CODEX_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'] as const
const MAX_AGENT_RUNTIME_MS = 300_000
const AGENT_STATUS_TIMEOUT_MS = 10_000

export type AgentEvent = AgentStreamEvent

const CLAUDE_MODELS: AgentModelCatalog['claude'] = [
  {
    id: 'default',
    label: 'Claude default',
    description: 'Uses the model selected by your Claude Code configuration.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    default: true
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet 5',
    description: 'Balanced speed and capability for everyday engineering.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'opus',
    label: 'Claude Opus 5',
    description: 'Strong capability for complex agentic coding and enterprise work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'fable',
    label: 'Claude Fable 5',
    description: 'Highest capability for difficult, long-running agent tasks.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'haiku',
    label: 'Claude Haiku 4.5',
    description: 'Fastest option for simple questions and code lookup.',
    efforts: [],
    defaultEffort: ''
  }
]

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The agent request timed out.')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

async function* idleClaudeInput(): AsyncGenerator<never, void, unknown> {
  await new Promise<never>(() => {})
}

async function listClaudeModels(executable: string, cwd: string): Promise<AgentModelCatalog['claude']> {
  const runtime = queryClaude({
    prompt: idleClaudeInput(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      settingSources: [],
      tools: []
    }
  })
  try {
    const discovered = await withTimeout(runtime.supportedModels(), AGENT_STATUS_TIMEOUT_MS)
    return discovered.map((model, index) => ({
      id: model.value,
      label: model.displayName,
      description: model.description,
      efforts: model.supportedEffortLevels ?? [],
      defaultEffort: model.supportedEffortLevels?.includes('high') === true ? 'high' : '',
      ...(model.value === 'default' || index === 0 ? { default: true } : {})
    }))
  } finally {
    runtime.close()
  }
}

async function resolveExecutable(candidates: readonly string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      await access(candidate, fileConstants.X_OK)
      return candidate
    } catch {
      // Try the next known install location.
    }
  }
  return fallback
}

export function getClaudeAccessConfig(accessMode: AgentAskRequest['accessMode'], cwd = process.cwd()): {
  permissionMode: PermissionMode
  tools: ClaudeOptions['tools']
  allowedTools?: string[]
  allowDangerouslySkipPermissions?: boolean
  sandbox?: ClaudeOptions['sandbox']
} {
  if (accessMode === 'review') {
    return {
      permissionMode: 'dontAsk',
      tools: [...AGENT_READ_ONLY_TOOLS, 'Bash'],
      allowedTools: [...AGENT_READ_ONLY_TOOLS, 'Bash'],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [cwd] }
      }
    }
  }
  if (accessMode === 'auto') {
    return {
      permissionMode: 'auto',
      tools: { type: 'preset', preset: 'claude_code' },
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true
      }
    }
  }
  return {
    permissionMode: 'bypassPermissions',
    tools: { type: 'preset', preset: 'claude_code' },
    allowDangerouslySkipPermissions: true
  }
}

interface ProcessResult {
  stdout: string
  stderr: string
  code: number | null
}

function runProcess(executable: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-64_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', reject)
    const timeout = setTimeout(() => child.kill(), AGENT_STATUS_TIMEOUT_MS)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ stdout, stderr, code })
    })
  })
}

async function executableVersion(executable: string): Promise<string | undefined> {
  try {
    const result = await runProcess(executable, ['--version'])
    const version = result.stdout.trim() || result.stderr.trim()
    return version === '' ? undefined : version.split('\n')[0]
  } catch {
    return undefined
  }
}

async function getProviderStatus(provider: AgentProvider): Promise<AgentProviderStatus> {
  const candidates = provider === 'claude' ? CLAUDE_CANDIDATES : CODEX_CANDIDATES
  const fallback = provider === 'claude' ? 'claude' : 'codex'
  const executable = await resolveExecutable(candidates, fallback)
  const version = await executableVersion(executable)
  try {
    const result = await runProcess(executable, provider === 'claude'
      ? ['auth', 'status']
      : ['login', 'status'])
    if (provider === 'claude') {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      const authenticated = parsed.loggedIn === true
      const account = typeof parsed.email === 'string'
        ? parsed.email
        : typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null
      return {
        provider,
        installed: true,
        authenticated,
        label: authenticated ? 'Connected' : 'Sign-in required',
        detail: authenticated
          ? account ?? 'Claude Code is ready.'
          : 'The Claude OAuth session is missing or expired.',
        ...(version == null ? {} : { version })
      }
    }
    const authenticated = result.code === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`)
    return {
      provider,
      installed: true,
      authenticated,
      label: authenticated ? 'Connected' : 'Sign-in required',
      detail: authenticated ? result.stdout.trim() || 'Codex is ready.' : 'Sign in with ChatGPT to use Codex.',
      ...(version == null ? {} : { version })
    }
  } catch (error) {
    return {
      provider,
      installed: version != null,
      authenticated: false,
      label: version == null ? 'Not installed' : 'Status unavailable',
      detail: error instanceof Error ? error.message : `Could not check ${provider}.`,
      ...(version == null ? {} : { version })
    }
  }
}

export class AgentService {
  #active = new Map<string, { close(): void }>()
  // Reused across turns: starting the app-server also starts the user's MCP
  // servers, which costs seconds.
  #codex = new CodexAppServer()
  #codexRequests = new Set<string>()
  #pendingApprovals = new Map<string, {
    agentRequestId: string
    resolve(decision: AgentApprovalDecision): void
  }>()

  async getModels(cwd: string): Promise<AgentModelCatalog> {
    const [claudeExecutable, codexExecutable] = await Promise.all([
      resolveExecutable(CLAUDE_CANDIDATES, 'claude'),
      resolveExecutable(CODEX_CANDIDATES, 'codex')
    ])
    let codex: AgentModelCatalog['codex'] = [{
      id: 'default',
      label: 'Codex default',
      description: 'Uses the default model in your Codex configuration.',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      default: true
    }]
    try {
      const discovered = await this.#codex.listModels(codexExecutable, cwd)
      if (discovered.length > 0) codex = discovered
    } catch {}
    let claude = CLAUDE_MODELS
    try {
      const discovered = await listClaudeModels(claudeExecutable, cwd)
      if (discovered.length > 0) claude = discovered
    } catch {}
    return { claude, codex }
  }

  async getStatuses(): Promise<AgentProviderStatuses> {
    const [claude, codex] = await Promise.all([
      getProviderStatus('claude'),
      getProviderStatus('codex')
    ])
    return { claude, codex }
  }

  async login(providerValue: unknown): Promise<void> {
    if (providerValue !== 'claude' && providerValue !== 'codex') {
      throw new Error('The agent provider is not valid.')
    }
    const provider: AgentProvider = providerValue
    const executable = await resolveExecutable(
      provider === 'claude' ? CLAUDE_CANDIDATES : CODEX_CANDIDATES,
      provider
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, provider === 'claude' ? ['auth', 'login'] : ['login'], {
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  respondApproval(requestId: unknown, decision: unknown): void {
    if (typeof requestId !== 'string' ||
        (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline')) return
    const pending = this.#pendingApprovals.get(requestId)
    if (pending == null) return
    this.#pendingApprovals.delete(requestId)
    pending.resolve(decision)
  }

  cancel(id: unknown): void {
    if (typeof id !== 'string') return
    if (this.#codexRequests.delete(id)) {
      for (const [requestId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== id) continue
        this.#pendingApprovals.delete(requestId)
        pending.resolve('decline')
      }
      this.#codex.interrupt()
      return
    }
    const child = this.#active.get(id)
    if (child == null) return
    this.#active.delete(id)
    child.close()
  }

  cancelAll(): void {
    for (const id of [...this.#active.keys()]) this.cancel(id)
    this.#codexRequests.clear()
    for (const pending of this.#pendingApprovals.values()) pending.resolve('decline')
    this.#pendingApprovals.clear()
    this.#codex.stop()
  }

  // Codex streams only through the app-server's JSON-RPC notifications; its
  // `exec --json` transport has no token deltas at all.
  async #askCodex(
    request: AgentAskRequest,
    executable: string,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    this.#codexRequests.add(request.id)
    const readText = createAgentTextReader()
    const prompt = request.context === ''
      ? composeAgentPrompt(request.prompt)
      : composeAgentPrompt(request.prompt, request.context)
    let failure: string | null = null
    let emittedSessionId: string | null = null
    try {
      await this.#codex.ask({
        executable,
        cwd,
        prompt,
        model: request.model,
        effort: request.effort,
        accessMode: request.accessMode,
        ...(request.resumeSessionId == null ? {} : { resumeThreadId: request.resumeSessionId }),
        handlers: {
          onChunk: (chunk) => {
            if (!this.#codexRequests.has(request.id)) return
            for (const activity of chunk.activities ?? (chunk.activity == null ? [] : [chunk.activity])) {
              emit({ id: request.id, kind: 'activity', activity })
            }
            if (chunk.usage != null) {
              emit({
                id: request.id,
                kind: 'usage',
                usage: { model: request.model, ...chunk.usage }
              })
            }
            if (chunk.kind === 'session' && chunk.sessionId != null) {
              if (chunk.sessionId !== emittedSessionId) {
                emittedSessionId = chunk.sessionId
                emit({ id: request.id, kind: 'session', sessionId: chunk.sessionId })
              }
              return
            }
            if (chunk.kind === 'activity') {
              return
            }
            if (chunk.kind === 'result' && chunk.failed === true) {
              failure = chunk.text == null || chunk.text === '' ? 'Codex could not finish the turn.' : chunk.text
              return
            }
            const text = readText(chunk)
            if (text != null) emit({ id: request.id, kind: 'text', text })
          },
          onRateLimit: (limit) => {
            const duration = limit.windowDurationMinutes
            const label = duration == null
              ? 'Plan'
              : duration >= 10_080 ? '7-day' : duration >= 300 ? '5-hour' : 'Plan'
            emit({
              id: request.id,
              kind: 'usage',
              usage: {
                rateLimits: [{
                  label,
                  usedPercent: limit.usedPercent,
                  resetsAt: limit.resetsAtSeconds
                }]
              }
            })
            // Worth saying out loud: a nearly spent window is the usual reason a
            // turn crawls or refuses.
            if (limit.usedPercent >= 90) {
              emit({
                id: request.id,
                kind: 'activity',
                activity: {
                  id: 'codex-rate-limit',
                  kind: 'status',
                  title: `Plan usage is ${Math.round(limit.usedPercent)}%`,
                  status: 'completed'
                }
              })
            }
          },
          onApproval: (approval) => new Promise((resolve) => {
            this.#pendingApprovals.set(approval.requestId, {
              agentRequestId: request.id,
              resolve
            })
            emit({ id: request.id, kind: 'approval', approval })
            emit({
              id: request.id,
              kind: 'activity',
              activity: {
                id: approval.itemId,
                kind: approval.type === 'command'
                  ? 'command'
                  : approval.type === 'file-change' ? 'file' : 'status',
                title: approval.title,
                detail: approval.detail,
                status: 'waiting'
              }
            })
          })
        }
      })
    } finally {
      this.#codexRequests.delete(request.id)
      for (const [approvalId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== request.id) continue
        this.#pendingApprovals.delete(approvalId)
        pending.resolve('decline')
      }
    }
    if (failure != null) {
      emit({ id: request.id, kind: 'error', text: failure })
      return
    }
    emit({ id: request.id, kind: 'done' })
  }

  async #askClaude(
    request: AgentAskRequest,
    executable: string,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const access = getClaudeAccessConfig(request.accessMode, cwd)
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (request.accessMode === 'full-access') return { behavior: 'allow', updatedInput: input }
      if (request.accessMode === 'review') {
        return (AGENT_REVIEW_TOOLS as readonly string[]).includes(toolName)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Review mode is read-only.' }
      }

      const requestId = `claude-${options.requestId}`
      const itemId = options.toolUseID
      const type = toolName === 'Bash'
        ? 'command'
        : toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit'
          ? 'file-change'
          : 'permissions'
      const detail = options.description ?? options.decisionReason ?? describeClaudeTool(toolName, input)
      const decision = await new Promise<AgentApprovalDecision>((resolve) => {
        this.#pendingApprovals.set(requestId, { agentRequestId: request.id, resolve })
        const onAbort = (): void => {
          const pending = this.#pendingApprovals.get(requestId)
          if (pending == null) return
          this.#pendingApprovals.delete(requestId)
          pending.resolve('decline')
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        emit({
          id: request.id,
          kind: 'approval',
          approval: {
            requestId,
            itemId,
            type,
            title: options.title ?? `Allow ${options.displayName ?? toolName}?`,
            detail
          }
        })
        emit({
          id: request.id,
          kind: 'activity',
          activity: {
            id: itemId,
            kind: type === 'command' ? 'command' : type === 'file-change' ? 'file' : 'tool',
            title: options.displayName ?? toolName,
            detail,
            status: 'waiting'
          }
        })
      })
      if (decision === 'decline') return { behavior: 'deny', message: 'The user denied this tool.' }
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(decision === 'acceptForSession' && options.suggestions != null
          ? {
              updatedPermissions: options.suggestions.map((suggestion) => ({
                ...suggestion,
                destination: 'session' as const
              }))
            }
          : {})
      }
    }

    const runtime = queryClaude({
      prompt: composeAgentPrompt(request.prompt, request.context),
      options: {
        cwd,
        pathToClaudeCodeExecutable: executable,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(request.accessMode === 'auto' ? { canUseTool } : {}),
        ...access,
        ...(request.model === '' || request.model === 'default' ? {} : { model: request.model }),
        ...(request.effort === '' || request.effort === 'default'
          ? {}
          : { effort: request.effort as NonNullable<ClaudeOptions['effort']> }),
        ...(request.resumeSessionId == null
          ? {}
          : { resume: request.resumeSessionId, forkSession: true })
      }
    })
    this.#active.set(request.id, runtime)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      runtime.close()
    }, MAX_AGENT_RUNTIME_MS)
    const readText = createAgentTextReader()
    let failure: string | null = null
    let emittedSessionId: string | null = null
    try {
      for await (const message of runtime) {
        if (!this.#active.has(request.id)) return
        const chunk = interpretAgentLine(JSON.stringify(message), request.accessMode)
        if (chunk == null) continue
        for (const activity of chunk.activities ?? (chunk.activity == null ? [] : [chunk.activity])) {
          emit({ id: request.id, kind: 'activity', activity })
        }
        if (chunk.usage != null) {
          emit({ id: request.id, kind: 'usage', usage: { model: request.model, ...chunk.usage } })
        }
        if (chunk.kind === 'session' && chunk.sessionId != null) {
          if (chunk.sessionId !== emittedSessionId) {
            emittedSessionId = chunk.sessionId
            emit({ id: request.id, kind: 'session', sessionId: chunk.sessionId })
          }
        } else if (chunk.kind === 'result' && chunk.failed === true) {
          failure = chunk.text || 'Claude could not finish the turn.'
        } else if (chunk.kind !== 'activity') {
          const text = readText(chunk)
          if (text != null) emit({ id: request.id, kind: 'text', text })
        }
      }
    } finally {
      clearTimeout(timeout)
      runtime.close()
      this.#active.delete(request.id)
      for (const [approvalId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== request.id) continue
        this.#pendingApprovals.delete(approvalId)
        pending.resolve('decline')
      }
    }
    emit(timedOut
      ? { id: request.id, kind: 'error', text: 'Claude took too long to answer.' }
      : failure == null
        ? { id: request.id, kind: 'done' }
        : { id: request.id, kind: 'error', text: failure })
  }

  async ask(
    requestValue: unknown,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const request = await parseAgentAskRequest(requestValue)
    if (this.#active.has(request.id) || this.#codexRequests.has(request.id)) {
      throw new Error('This question is already running.')
    }

    const executable = request.provider === 'claude'
      ? await resolveExecutable(CLAUDE_CANDIDATES, 'claude')
      : await resolveExecutable(CODEX_CANDIDATES, 'codex')

    const status = await getProviderStatus(request.provider)
    if (!status.authenticated) {
      throw new Error(`${request.provider === 'claude' ? 'Claude Code' : 'Codex'} is not connected. Select Sign in in the agent panel.`)
    }

    if (request.provider === 'codex') {
      await this.#askCodex(request, executable, cwd, emit)
      return
    }
    await this.#askClaude(request, executable, cwd, emit)
  }
}

function describeClaudeTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command
  const path = typeof input.file_path === 'string' ? input.file_path : null
  if (path != null) return path
  const summary = JSON.stringify(input)
  return summary === '{}' ? toolName : summary.slice(0, 2_000)
}

function composeAgentPrompt(question: string, reviewContext = ''): string {
  const instructions = [
    'Answer from evidence in the open repository.',
    'Inspect the relevant files and call sites before reaching a conclusion.',
    'Use repository search and Git commands when the selected access mode permits them.',
    'For reviews, inspect beyond the patch when dependencies or callers affect the answer.',
    'Cite concrete file paths and line numbers. Separate verified facts from inferences.',
    'Do not change files unless the user explicitly asks for a change.'
  ].join(' ')
  if (reviewContext === '') return `${question}\n\nReview instructions: ${instructions}`
  return `${question}\n\nReview instructions: ${instructions}\n\nCurrent review context:\n${reviewContext}`
}
