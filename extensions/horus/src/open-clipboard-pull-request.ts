import { clipboardText, openHorusPullRequest } from './lib/open'

export default async function Command(): Promise<void> {
  await openHorusPullRequest(await clipboardText())
}
