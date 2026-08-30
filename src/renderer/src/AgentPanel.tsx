import { memo, useEffect, useRef, useState } from 'react'
import {
  IconArrow, IconBraces, IconCheck, IconChevronSm, IconClockArrow, IconCodeSearch,
  IconCommentAdd, IconCopy, IconFileCode, IconGear, IconInProgress, IconRefresh,
  IconShieldKeyhole, IconSparkles, IconToken,
  IconWarningOctogonFill, IconX
} from '@pierre/icons'

import type {
  AgentAccessMode, AgentActivityKind, AgentActivityUpdate, AgentApprovalDecision,
  AgentApprovalRequest, AgentModelOption, AgentProvider, AgentProviderStatuses,
  AgentUsageUpdate
} from '../../shared/contracts'
import {
  agentAttachmentId, formatAgentAttachment, type AgentAttachment
} from './agentAttachments'
import type { ConfirmRequest } from './ConfirmDialog'
import type { MarkdownBlock } from './markdown'
import { MarkdownContent } from './MarkdownContent'
import type { AgentTurnRecord } from './useAgentAnswer'

interface AgentPanelProps {
  answer: string
  blocks: MarkdownBlock[]
  streaming: boolean
  error: string | null
  question: string
  activity: readonly AgentActivityUpdate[]
  approvals: readonly AgentApprovalRequest[]
  usage: AgentUsageUpdate | null
  history: readonly AgentTurnRecord[]
  startedAt: number | null
  completedAt: number | null
  provider: AgentProvider
  model: string
  effort: string
  accessMode: AgentAccessMode
  accessModeLocked: boolean
  models: readonly AgentModelOption[]
  efforts: readonly string[]
  loadingModels: boolean
  statuses: AgentProviderStatuses
  loadingStatuses: boolean
  authenticatingProvider: AgentProvider | null
  statusError: string | null
  attachments: readonly AgentAttachment[]
  contextLabel: string
  onProviderChange(provider: AgentProvider): void
  onModelChange(model: string): void
  onEffortChange(effort: string): void
  onAccessModeChange(accessMode: AgentAccessMode): void
  onConfirm(request: ConfirmRequest): Promise<boolean>
  onRefreshStatuses(): void
  onLogin(provider: AgentProvider): void
  onApprovalDecision(requestId: string, decision: AgentApprovalDecision): void
  onRemoveAttachment(id: string): void
  onAsk(prompt: string): void
  onCancel(): void
  onReset(): void
  onClose(): void
}

const QUICK_PROMPTS = [
  { label: 'Explain', prompt: 'Explain what this change does and why, in a few short paragraphs.' },
  { label: 'Find risks', prompt: 'Review this change for bugs, edge cases, and risky behavior. Cite exact file paths and lines.' },
  { label: 'Test plan', prompt: 'Inspect the code and propose the highest-value tests. List concrete cases and affected files.' }
] as const

const RESET_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

export const AgentPanel = memo(function AgentPanel({
  answer, blocks, streaming, error, question, activity, approvals, usage, history,
  startedAt, completedAt, provider, model, effort, accessMode, accessModeLocked, models, efforts,
  loadingModels, statuses, loadingStatuses, authenticatingProvider, statusError,
  attachments, contextLabel, onProviderChange, onModelChange, onEffortChange,
  onAccessModeChange, onConfirm, onRefreshStatuses, onLogin, onApprovalDecision,
  onRemoveAttachment, onAsk, onCancel, onReset, onClose
}: AgentPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const started = history.length > 0 || question !== '' || blocks.length > 0 || activity.length > 0 || error != null
  const providerStatus = statuses[provider]
  const ready = providerStatus.authenticated
  const selectedModel = models.find((option) => option.id === model)
  const latestRunning = [...activity].reverse().find((item) =>
    item.status === 'running' || item.status === 'waiting')
  const liveLabel = latestRunning?.status === 'waiting'
    ? 'Waiting for approval'
    : latestRunning?.title || (blocks.length > 0 ? 'Writing answer' : 'Inspecting repository')

  const latestAttachment = attachments.at(-1)
  const latestAttachmentId = latestAttachment == null ? null : agentAttachmentId(latestAttachment)
  useEffect(() => {
    if (latestAttachmentId != null) composerRef.current?.focus()
  }, [latestAttachmentId])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript == null || !streaming) return
    const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
    if (distanceFromBottom < 120) transcript.scrollTop = transcript.scrollHeight
  }, [activity, blocks, streaming, usage])

  const send = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (trimmed === '' || streaming || !ready) return
    setSettingsOpen(false)
    onAsk(trimmed)
    setDraft('')
  }

  return (
    <aside className="agent-dock" aria-label="Agent">
      <header className="agent-dock-header">
        <div className="agent-dock-title">
          <IconSparkles aria-hidden="true" />
          <span>Agent</span>
        </div>
        <div className={`agent-header-state ${streaming ? 'running' : ready ? 'connected' : 'disconnected'}`}
          role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{streaming ? 'Working' : ready ? 'Ready' : 'Offline'}</span>
        </div>
        <div className="agent-dock-header-actions">
          {started ? (
            <button type="button" onClick={onReset} aria-label="New conversation" title="New conversation">
              <IconCommentAdd />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close agent panel" title="Close">
            <IconX />
          </button>
        </div>
      </header>

      <div className="agent-dock-transcript" ref={transcriptRef}>
        {!ready || statusError != null ? (
          <ProviderConnection provider={provider} status={providerStatus} loading={loadingStatuses}
            authenticating={authenticatingProvider === provider} error={statusError}
            onRefresh={onRefreshStatuses} onLogin={() => onLogin(provider)} />
        ) : null}

        {started ? null : (
          <div className="agent-dock-empty">
            <IconSparkles className="agent-empty-mark" aria-hidden="true" />
            <div>
              <h3>Review with an agent</h3>
              <p>Ask about {contextLabel}, or select diff lines and press <kbd>⌘I</kbd>.</p>
            </div>
            <div className="agent-quick-prompts">
              {QUICK_PROMPTS.map((quick) => (
                <button key={quick.label} type="button" disabled={streaming || !ready}
                  onClick={() => { setSettingsOpen(false); onAsk(quick.prompt) }}>{quick.label}</button>
              ))}
            </div>
            <p className="agent-privacy"><IconShieldKeyhole aria-hidden="true" />
              The selected provider receives repository context only when you send a request.</p>
          </div>
        )}

        {history.map((turn) => <AgentTurn key={turn.id} turn={turn} />)}

        {question === '' && blocks.length === 0 && activity.length === 0 && error == null ? null : (
          <article className="agent-turn current">
            {question === '' ? null : <p className="agent-question">{question}</p>}
            <TurnMeta provider={provider} model={selectedModel?.label ?? model} effort={effort}
              accessMode={accessMode} running={streaming} startedAt={startedAt}
              completedAt={completedAt} />
            {activity.length > 0 ? (
              <AgentActivityTimeline items={activity} streaming={streaming} liveLabel={liveLabel} />
            ) : null}

            {approvals.map((approval) => (
              <section className="agent-approval agent-state-surface" key={approval.requestId}
                aria-label="Agent approval request">
                <div className="agent-approval-heading">
                  <IconWarningOctogonFill aria-hidden="true" />
                  <span><strong>{approval.title}</strong><small>{approval.detail}</small></span>
                </div>
                <div className="agent-approval-actions">
                  <button type="button" onClick={() => onApprovalDecision(approval.requestId, 'decline')}>Deny</button>
                  <button type="button" onClick={() => onApprovalDecision(approval.requestId, 'acceptForSession')}>Allow for session</button>
                  <button type="button" className="primary" onClick={() => onApprovalDecision(approval.requestId, 'accept')}>Allow once</button>
                </div>
              </section>
            ))}

            {error != null ? <div className="agent-dock-error agent-state-surface" role="alert">{error}</div> : null}
            {blocks.length > 0 ? <MarkdownContent blocks={blocks} className="agent-answer" /> : null}
            {streaming && activity.length === 0 ? <LiveStatus label={liveLabel} /> : null}
            {usage == null || streaming ? null : <UsageSummary usage={usage} />}
            {answer === '' || streaming ? null : <AnswerActions answer={answer} />}
          </article>
        )}
      </div>

      <div className="agent-composer">
        <form onSubmit={(event) => { event.preventDefault(); send(draft) }}>
          {attachments.length > 0 ? (
            <div className="agent-attachments" aria-label="Attached selections">
              {attachments.map((attachment) => {
                const id = agentAttachmentId(attachment)
                const label = formatAgentAttachment(attachment)
                return (
                  <span className="agent-attachment" key={id}
                    title={`${attachment.subject.repositoryName} · ${attachment.path} · ${attachment.side === 'deletions' ? 'old' : 'new'} side`}>
                    <code>{label}</code>
                    <button type="button" onClick={() => onRemoveAttachment(id)}
                      aria-label={`Remove ${label}`}><IconX /></button>
                  </span>
                )
              })}
            </div>
          ) : null}
          <textarea ref={composerRef} value={draft} name="agent-question" rows={1} disabled={!ready}
            placeholder={!ready ? `Connect ${provider === 'claude' ? 'Claude Code' : 'Codex'} to continue…`
              : started ? 'Send a follow-up…' : 'Ask about this code…'}
            aria-label={started ? 'Send a follow-up' : 'Ask about this code'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              send(draft)
            }} />
          {settingsOpen ? (
            <div className="agent-config-panel agent-state-surface" aria-label="Agent settings">
              <AgentConfigField label="Provider" controlId="agent-provider">
                <AgentSelect label="Provider" name="agent-provider" value={provider}
                  onChange={(value) => onProviderChange(value as AgentProvider)}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </AgentSelect>
              </AgentConfigField>
              <AgentConfigField label="Model" controlId="agent-model">
                <AgentSelect label="Model" name="agent-model" value={model} disabled={loadingModels}
                  title={selectedModel?.description} onChange={onModelChange} grow>
                  {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </AgentSelect>
              </AgentConfigField>
              <AgentConfigField label="Access" controlId="agent-access">
                <AgentSelect label="Access" name="agent-access" value={accessMode}
                  disabled={accessModeLocked}
                  title={accessModeLocked
                    ? 'Patch and Since tabs are read-only because they do not own a writable checkout.'
                    : ACCESS_MODES[accessMode].description}
                  onChange={async (value) => {
                    const nextMode = value as AgentAccessMode
                    if (nextMode === 'full-access' && accessMode !== 'full-access' &&
                        !(await onConfirm({
                          title: 'Enable full access?',
                          detail: 'The agent can run commands and change files without approval until Horus restarts.',
                          confirmLabel: 'Enable full access',
                          destructive: true
                        }))) return
                    onAccessModeChange(nextMode)
                  }}>
                  {Object.entries(ACCESS_MODES).map(([value, option]) =>
                    <option key={value} value={value}>{option.label}</option>)}
                </AgentSelect>
              </AgentConfigField>
              <AgentConfigField label="Effort" controlId="agent-effort">
                <AgentSelect label="Reasoning effort" name="agent-effort" value={effort}
                  disabled={efforts.length === 0} onChange={onEffortChange}>
                  {efforts.length === 0 ? <option value="">Standard</option> : efforts.map((value) =>
                    <option key={value} value={value}>{EFFORT_LABELS[value] ?? value}</option>)}
                </AgentSelect>
              </AgentConfigField>
              <p className="agent-config-help"><IconShieldKeyhole aria-hidden="true" />
                {accessModeLocked
                  ? 'Patch and Since tabs are locked to Review access. The agent receives exact selected code but cannot modify another checkout.'
                  : ACCESS_MODES[accessMode].description}</p>
            </div>
          ) : null}
          <div className="agent-composer-actions">
            <button type="button" className="agent-config-toggle" aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)} title="Agent settings">
              <IconGear aria-hidden="true" />
              <span>{provider === 'claude' ? 'Claude Code' : 'Codex'} · {selectedModel?.label ?? model}</span>
              <small>{ACCESS_MODES[accessMode].label} · {EFFORT_LABELS[effort] ?? (effort || 'Standard')}</small>
              <IconChevronSm className="agent-config-chevron" aria-hidden="true" />
            </button>
            {streaming ? (
              <button type="button" className="agent-send stopping" onClick={onCancel}
                aria-label="Stop the answer" title="Stop"><span className="agent-stop-icon" aria-hidden="true" /></button>
            ) : (
              <button type="submit" className="agent-send" disabled={draft.trim() === '' || !ready}
                aria-label="Send message" title="Send message"><IconArrow /></button>
            )}
          </div>
        </form>
      </div>
    </aside>
  )
})

const ACCESS_MODES: Record<AgentAccessMode, { label: string; description: string }> = {
  review: { label: 'Review', description: 'Read, search, and sandboxed Bash. Repository writes are blocked.' },
  auto: { label: 'Auto', description: 'Run sandboxed commands and workspace edits. Ask when more access is required.' },
  'full-access': { label: 'Full access', description: 'Run without approvals or sandbox limits until Horus restarts.' }
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra'
}

function ProviderConnection({ provider, status, loading, authenticating, error, onRefresh, onLogin }: {
  provider: AgentProvider
  status: AgentProviderStatuses[AgentProvider]
  loading: boolean
  authenticating: boolean
  error: string | null
  onRefresh(): void
  onLogin(): void
}): React.JSX.Element {
  const providerLabel = provider === 'claude' ? 'Claude Code' : 'Codex'
  return (
    <section className="agent-connection agent-state-surface" aria-label={`${providerLabel} connection`}>
      <div className="agent-connection-copy">
        <span className="agent-connection-title"><i aria-hidden="true" />{providerLabel}</span>
        <strong>{authenticating ? 'Complete sign-in in your browser' : status.label}</strong>
        <p>{error ?? status.detail}</p>
        {status.version == null ? null : <code>{status.version}</code>}
      </div>
      <div className="agent-connection-actions">
        <button type="button" onClick={onRefresh} disabled={loading} title="Check connection"
          aria-label="Check connection"><IconRefresh className={loading ? 'spin' : ''} /></button>
        <button type="button" className="primary" onClick={onLogin} disabled={authenticating || !status.installed}>
          {authenticating ? 'Waiting…' : 'Sign in'}
        </button>
      </div>
    </section>
  )
}

// Archived turns never change again, and their props keep identity, so an
// answer streaming below them must not re-render the whole history per token.
const AgentTurn = memo(function AgentTurn({ turn }: { turn: AgentTurnRecord }): React.JSX.Element {
  return (
    <article className="agent-turn archived">
      <p className="agent-question">{turn.question}</p>
      <TurnMeta provider={turn.provider} model={turn.model} effort={turn.effort}
        accessMode={turn.accessMode} running={false} startedAt={turn.startedAt}
        completedAt={turn.completedAt} />
      {turn.activity.length > 0 ? (
        <AgentActivityTimeline items={turn.activity} streaming={false} liveLabel="Complete" />
      ) : null}
      {turn.error == null ? null : <div className="agent-dock-error" role="alert">{turn.error}</div>}
      {turn.blocks.length === 0 ? null : <MarkdownContent blocks={turn.blocks} className="agent-answer" />}
      {turn.usage == null ? null : <UsageSummary usage={turn.usage} />}
      {turn.answer === '' ? null : <AnswerActions answer={turn.answer} />}
    </article>
  )
})

function TurnMeta({ provider, model, effort, accessMode, running, startedAt, completedAt }: {
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  running: boolean
  startedAt: number | null
  completedAt: number | null
}): React.JSX.Element {
  const elapsed = useElapsedSeconds(startedAt, completedAt, running)
  const providerLabel = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Agent'
  const configuration = [EFFORT_LABELS[effort] ?? effort, accessMode == null ? '' : ACCESS_MODES[accessMode].label]
    .filter(Boolean).join(' · ')
  return (
    <div className="agent-turn-meta" title={configuration}>
      <span>{providerLabel}{model === '' ? '' : ` · ${model}`}</span>
      {accessMode === 'full-access' ? <strong>Full access</strong> : null}
      {elapsed == null ? null : <small className="tabular"><IconClockArrow aria-hidden="true" />{formatDuration(elapsed * 1_000)}</small>}
    </div>
  )
}

function useElapsedSeconds(startedAt: number | null, completedAt: number | null, running: boolean): number | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running || startedAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  if (startedAt == null) return null
  return Math.max(0, Math.round(((completedAt ?? now) - startedAt) / 1_000))
}

function LiveStatus({ label }: { label: string }): React.JSX.Element {
  return <div className="agent-live-status" role="status" aria-live="polite">
    <i className="agent-live-dot" aria-hidden="true" /><span>{label}</span>
  </div>
}

function UsageSummary({ usage }: { usage: AgentUsageUpdate }): React.JSX.Element {
  const total = usage.totalTokens ?? 0
  const contextPercent = usage.contextWindow == null || usage.contextWindow === 0
    ? null
    : Math.min(100, total / usage.contextWindow * 100)
  const metrics = [
    { label: 'Input', value: usage.inputTokens }, { label: 'Output', value: usage.outputTokens },
    { label: 'Cached', value: usage.cachedInputTokens }, { label: 'Reasoning', value: usage.reasoningTokens }
  ].filter((metric) => metric.value != null)
  return (
    <details className="agent-usage agent-state-surface">
      <summary>
        <IconToken aria-hidden="true" /><span>Usage</span><strong>{formatTokens(total)} tokens</strong>
        {usage.durationMs == null || usage.durationMs === 0 ? null : <small>{formatDuration(usage.durationMs)}</small>}
        <IconChevronSm className="agent-usage-chevron" aria-hidden="true" />
      </summary>
      <div className="agent-usage-body">
        {contextPercent == null ? null : <UsageMeter label="Context" value={contextPercent} />}
        <dl className="agent-usage-grid">
          {metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{formatTokens(metric.value ?? 0)}</dd></div>)}
          {usage.costUsd == null || usage.costUsd === 0 ? null : <div><dt>Estimated cost</dt><dd>${usage.costUsd.toFixed(4)}</dd></div>}
          {usage.turns == null || usage.turns === 0 ? null : <div><dt>Model turns</dt><dd>{usage.turns}</dd></div>}
        </dl>
        {usage.rateLimits?.map((window) => <div className="agent-rate-limit" key={window.label}>
          <UsageMeter label={`${window.label} plan`} value={window.usedPercent} suffix=" used" />
          {window.resetsAt == null ? null : <small>Resets {formatReset(window.resetsAt)}</small>}
        </div>)}
      </div>
    </details>
  )
}

function UsageMeter({ label, value, suffix = '' }: { label: string; value: number; suffix?: string }): React.JSX.Element {
  const safeValue = Math.min(100, Math.max(0, value))
  return <div className="agent-context-meter">
    <div><span>{label}</span><strong>{safeValue.toFixed(value < 10 ? 1 : 0)}%{suffix}</strong></div>
    <meter min="0" max="100" value={safeValue}>{safeValue}%</meter>
  </div>
}

function AnswerActions({ answer }: { answer: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyAnswer = async (): Promise<void> => {
    await navigator.clipboard.writeText(answer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_600)
  }
  return <div className="agent-answer-actions"><button type="button" onClick={() => {
    void copyAnswer()
  }}>{copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}{copied ? 'Copied' : 'Copy answer'}</button></div>
}

function AgentSelect({ label, name, value, title, disabled, grow, children, onChange }: {
  label: string
  name: string
  value: string
  title?: string
  disabled?: boolean
  grow?: boolean
  children: React.ReactNode
  onChange(value: string): void
}): React.JSX.Element {
  return <span className={`agent-select select-control ${grow ? 'grow' : ''}`} title={title}>
    <select id={name} name={name} aria-label={label} value={value} disabled={disabled}
      onChange={(event) => onChange(event.target.value)}>{children}</select>
    <IconChevronSm aria-hidden="true" />
  </span>
}

function AgentConfigField({ label, controlId, children }: {
  label: string
  controlId: string
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="agent-config-field"><label htmlFor={controlId}>{label}</label>{children}</div>
}

function ActivityIcon({ kind }: { kind: AgentActivityKind }): React.JSX.Element {
  if (kind === 'reasoning' || kind === 'plan') return <IconSparkles aria-hidden="true" />
  if (kind === 'search') return <IconCodeSearch aria-hidden="true" />
  if (kind === 'file') return <IconFileCode aria-hidden="true" />
  if (kind === 'command' || kind === 'tool') return <IconBraces aria-hidden="true" />
  return <IconCheck aria-hidden="true" />
}

const AgentActivityTimeline = memo(function AgentActivityTimeline({ items, streaming, liveLabel }: {
  items: readonly AgentActivityUpdate[]
  streaming: boolean
  liveLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const failed = items.some((item) => item.status === 'failed' || item.status === 'blocked')
  const summary = streaming ? liveLabel : failed ? 'Completed with issues' : 'Activity'
  return <details className="agent-work-log" open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="agent-work-log-heading">
      {streaming ? <IconInProgress className="agent-work-log-status running" aria-hidden="true" />
        : failed ? <IconWarningOctogonFill className="agent-work-log-status failed" aria-hidden="true" />
          : <IconCheck className="agent-work-log-status" aria-hidden="true" />}
      <span>{summary}</span><small>{items.length} {items.length === 1 ? 'step' : 'steps'}</small>
      <IconChevronSm className="agent-work-log-chevron" aria-hidden="true" />
    </summary>
    {/* The steps mount only while the timeline is open: a collapsed history of
        20 turns would otherwise hold ~1,600 rows in the document, and every
        reasoning delta would rewrite a text node nobody can see. */}
    {open ? <ol className="agent-activity" aria-label="Agent steps">
      {items.map((item) => <AgentActivityRow item={item} key={item.id} />)}
    </ol> : null}
  </details>
})

const AgentActivityRow = memo(function AgentActivityRow({ item }: {
  item: AgentActivityUpdate
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = (item.detail ?? '') !== '' || (item.output ?? '') !== ''
  const duration = item.durationMs == null || item.durationMs < 1_000 ? null : formatDuration(item.durationMs)

  return <li className={`agent-activity-item ${item.status}`}>
    {expandable ? <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><ActivityIcon kind={item.kind} /><span>{item.title}</span>
        <small>{duration ?? formatActivityStatus(item.status)}</small>
        <IconChevronSm className="agent-activity-chevron" aria-hidden="true" /></summary>
      {!open || item.detail == null || item.detail === '' ? null : <pre>{item.detail}</pre>}
      {!open || item.output == null || item.output === '' ? null : <pre className="output">{item.output}</pre>}
    </details> : <div className="agent-activity-summary"><ActivityIcon kind={item.kind} />
      <span>{item.title}</span><small>{duration ?? formatActivityStatus(item.status)}</small></div>}
  </li>
})

function formatActivityStatus(status: AgentActivityUpdate['status']): string {
  if (status === 'waiting') return 'Approval'
  if (status === 'blocked') return 'Blocked'
  if (status === 'failed') return 'Failed'
  if (status === 'running') return 'Running'
  return 'Done'
}

function formatTokens(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString()
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatReset(timestamp: number): string {
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp)
  return RESET_TIME_FORMATTER.format(date)
}
