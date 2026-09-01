import { Action, ActionPanel, Clipboard, Icon, LaunchProps, List, closeMainWindow, showHUD } from '@raycast/api'
import { useEffect, useRef, useState } from 'react'

import { describeGitHubPullRequest, extractGitHubPullRequestUrl } from './lib/github'
import { sendToHorus } from './lib/horus'

export default function Command(props: LaunchProps<{ arguments: Arguments.OpenPullRequest; fallbackText?: string }>) {
  const incoming = extractGitHubPullRequestUrl(props.arguments.url ?? '')
    ?? extractGitHubPullRequestUrl(props.fallbackText ?? '')
  const [search, setSearch] = useState(incoming ?? '')
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const [opening, setOpening] = useState(incoming != null)
  const [warmedUrls, setWarmedUrls] = useState<readonly string[]>([])
  const warmed = useRef(new Set<string>())

  useEffect(() => {
    if (incoming != null) {
      void openUrl(incoming)
      return
    }
    void Clipboard.readText().then((text) => {
      const url = extractGitHubPullRequestUrl(text ?? '')
      setClipboardUrl(url)
      if (url != null) void warmup(url)
    })
  }, [incoming])

  useEffect(() => {
    const url = extractGitHubPullRequestUrl(search)
    if (url != null) void warmup(url)
  }, [search])

  async function warmup(url: string): Promise<void> {
    if (warmed.current.has(url)) return
    warmed.current.add(url)
    setWarmedUrls((current) => current.includes(url) ? current : [...current, url])
    try {
      await sendToHorus(url, 'warmup')
    } catch {
      warmed.current.delete(url)
      setWarmedUrls((current) => current.filter((item) => item !== url))
    }
  }

  async function openUrl(url: string): Promise<void> {
    setOpening(true)
    try {
      await closeMainWindow({ clearRootSearch: true })
      await sendToHorus(url, 'open')
    } catch (error) {
      setOpening(false)
      await showHUD(error instanceof Error ? error.message : 'Could not open Horus')
    }
  }

  const typed = extractGitHubPullRequestUrl(search)
  const candidate = typed ?? clipboardUrl
  const description = candidate == null ? null : describeGitHubPullRequest(candidate)

  return (
    <List
      isLoading={opening}
      searchText={search}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Paste a GitHub pull request URL"
      throttle
    >
      {candidate != null && description != null ? (
        <List.Item
          title={`${description.owner}/${description.repository}#${description.number}`}
          subtitle={candidate}
          icon={Icon.Eye}
          accessories={[{ text: warmedUrls.includes(candidate) ? 'Warming in Horus' : 'Open in Horus' }]}
          actions={
            <ActionPanel>
              <Action title="Open in Horus" icon={Icon.Eye} onAction={() => void openUrl(candidate)} />
              <Action title="Warm in Background" icon={Icon.Clock} onAction={() => void warmup(candidate)} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView
          icon={Icon.Link}
          title={search.trim() === '' ? 'Paste a GitHub pull request URL' : 'Not a GitHub pull request URL'}
          description="Horus starts loading the review as soon as the URL looks valid."
        />
      )}
    </List>
  )
}
