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
        streaming={session.answer.streaming}
        error={session.answer.error}
        question={session.answer.question}
        activity={session.answer.activity}
        provider={session.provider}
        attachments={session.attachments}
        contextLabel={contextLabel}
        onProviderChange={session.setProvider}
        onRemoveAttachment={session.removeAttachment}
        onAsk={session.ask}
        onCancel={session.answer.cancel}
        onReset={session.answer.reset}
        onClose={session.close}
      />
    </Suspense>
  )
}
