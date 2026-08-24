import { lazy, Suspense } from 'react'

import type { useAgentSession } from './useAgentSession'

const AgentPanel = lazy(async () => ({ default: (await import('./AgentPanel')).AgentPanel }))

interface AgentDockProps {
  session: ReturnType<typeof useAgentSession>
  contextLabel: string
}

// Keeps the panel's wiring next to the panel: the workspace only decides where
// the column sits, not how the conversation is plumbed together.
export function AgentDock({ session, contextLabel }: AgentDockProps): React.JSX.Element | null {
  if (!session.open) return null
  return (
    <Suspense fallback={<aside className="agent-dock" />}>
      <AgentPanel
        blocks={session.answer.blocks}
        answer={session.answer.answer}
        streaming={session.answer.streaming}
        error={session.answer.error}
        question={session.answer.question}
        activity={session.answer.activity}
        approvals={session.answer.approvals}
        usage={session.answer.usage}
        history={session.answer.history}
        startedAt={session.answer.startedAt}
        completedAt={session.answer.completedAt}
        provider={session.provider}
        model={session.model}
        effort={session.effort}
        accessMode={session.accessMode}
        models={session.models}
        efforts={session.efforts}
        loadingModels={session.loadingModels}
        statuses={session.statuses}
        loadingStatuses={session.loadingStatuses}
        authenticatingProvider={session.authenticatingProvider}
        statusError={session.statusError}
        attachments={session.attachments}
        contextLabel={contextLabel}
        onProviderChange={session.setProvider}
        onModelChange={session.setModel}
        onEffortChange={session.setEffort}
        onAccessModeChange={session.setAccessMode}
        onRefreshStatuses={session.refreshStatuses}
        onLogin={session.login}
        onApprovalDecision={session.answer.respondToApproval}
        onRemoveAttachment={session.removeAttachment}
        onAsk={session.ask}
        onCancel={session.answer.cancel}
        onReset={session.answer.reset}
        onClose={session.close}
      />
    </Suspense>
  )
}
