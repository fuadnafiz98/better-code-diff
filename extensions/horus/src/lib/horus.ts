import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { formatHorusReviewUrl } from './github'

const execFileAsync = promisify(execFile)

export type HorusIntent = 'open' | 'warmup'

export async function sendToHorus(pullRequestUrl: string, intent: HorusIntent): Promise<void> {
  const deepLink = formatHorusReviewUrl(pullRequestUrl, intent)
  if (deepLink == null) throw new Error('That is not a GitHub pull request URL.')

  try {
    await execFileAsync('open', intent === 'warmup' ? ['-g', deepLink] : [deepLink])
  } catch {
    const fallback = intent === 'warmup'
      ? ['-g', '-a', 'Horus', '--args', `--horus-url=${deepLink}`]
      : ['-a', 'Horus', '--args', `--horus-url=${deepLink}`]
    try {
      await execFileAsync('open', fallback)
    } catch {
      throw new Error('Horus is not installed. Build it with `bun run update:mac`.')
    }
  }
}
