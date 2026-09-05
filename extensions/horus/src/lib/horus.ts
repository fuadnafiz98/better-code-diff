import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { formatHorusReviewUrl } from './github'

const execFileAsync = promisify(execFile)

export type HorusIntent = 'open' | 'warmup'

export const HORUS_NOT_INSTALLED = 'Horus is not installed. Build it with `bun run update:mac`.'
export const HORUS_SCHEME_UNREGISTERED =
  'macOS has no handler for horus://. Reinstall with `bun run update:mac`, then open Horus once.'

export type HorusLaunchPlan =
  | { kind: 'none' }
  | { kind: 'scheme'; args: string[] }
  | { kind: 'launch'; args: string[] }

/**
 * A running Horus is reached through the registered scheme, which lands on the
 * window that is already open instead of relaunching the app. Only a cold start
 * goes through `open -a`, and a warmup never does: warming is worth a message to
 * an app that is already up, not the cost of starting one in the background.
 */
export function horusLaunchPlan(input: {
  deepLink: string
  intent: HorusIntent
  running: boolean
}): HorusLaunchPlan {
  if (input.running) {
    return {
      kind: 'scheme',
      args: input.intent === 'warmup' ? ['-g', input.deepLink] : [input.deepLink]
    }
  }
  if (input.intent === 'warmup') return { kind: 'none' }
  return { kind: 'launch', args: ['-a', 'Horus', '--args', `--horus-url=${input.deepLink}`] }
}

export async function isHorusRunning(): Promise<boolean> {
  try {
    await execFileAsync('pgrep', ['-x', 'Horus'])
    return true
  } catch {
    // pgrep exits 1 when nothing matches, which is the answer rather than a failure.
    return false
  }
}

export async function sendToHorus(pullRequestUrl: string, intent: HorusIntent): Promise<void> {
  const deepLink = formatHorusReviewUrl(pullRequestUrl, intent)
  if (deepLink == null) throw new Error('That is not a GitHub pull request URL.')

  const plan = horusLaunchPlan({ deepLink, intent, running: await isHorusRunning() })
  if (plan.kind === 'none') return
  try {
    await execFileAsync('open', plan.args)
  } catch {
    throw new Error(plan.kind === 'scheme' ? HORUS_SCHEME_UNREGISTERED : HORUS_NOT_INSTALLED)
  }
}
