import { Cache, Clipboard, LaunchType, environment, showHUD } from '@raycast/api'

import { extractGitHubPullRequestUrl } from './lib/github'
import { sendToHorus } from './lib/horus'

const cache = new Cache({ namespace: 'horus-warmup' })

export default async function Command(): Promise<void> {
  const url = extractGitHubPullRequestUrl((await Clipboard.readText()) ?? '')
  if (url == null) {
    if (environment.launchType === LaunchType.UserInitiated) {
      await showHUD('Clipboard is not a GitHub pull request URL')
    }
    return
  }

  if (environment.launchType === LaunchType.Background && cache.get('url') === url) return
  cache.set('url', url)

  try {
    await sendToHorus(url, 'warmup')
    if (environment.launchType === LaunchType.UserInitiated) {
      await showHUD('Warming pull request in Horus')
    }
  } catch (error) {
    if (environment.launchType === LaunchType.UserInitiated) {
      await showHUD(error instanceof Error ? error.message : 'Could not reach Horus')
    }
  }
}
