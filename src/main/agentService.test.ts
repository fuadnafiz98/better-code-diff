import { describe, expect, test } from 'bun:test'

import { getClaudeAccessConfig } from './agentService.js'

describe('getClaudeAccessConfig', () => {
  test('allows Bash in a write-blocked review sandbox', () => {
    const config = getClaudeAccessConfig('review', '/work/repository')

    expect(config.permissionMode).toBe('dontAsk')
    expect(config.tools).toContain('Read')
    expect(config.tools).toContain('Bash')
    expect(config.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/work/repository'] }
    })
  })

  test('lets auto mode use the Claude Code tools with provider checks', () => {
    const config = getClaudeAccessConfig('auto')

    expect(config.permissionMode).toBe('auto')
    expect(config.tools).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(config.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('makes full access explicit', () => {
    const config = getClaudeAccessConfig('full-access')

    expect(config.permissionMode).toBe('bypassPermissions')
    expect(config.allowDangerouslySkipPermissions).toBe(true)
  })
})
