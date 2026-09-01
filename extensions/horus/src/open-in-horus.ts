import { LaunchProps } from '@raycast/api'

import { clipboardText, openHorusPullRequest } from './lib/open'

export default async function Command(props: LaunchProps): Promise<void> {
  await openHorusPullRequest(props.fallbackText, await clipboardText())
}
