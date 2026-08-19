import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

import type { ReviewThread } from './ReviewComments'
import {
  loadStoredReviewThreads,
  reviewThreadStorageKey,
  saveStoredReviewThreads
} from './reviewThreadStorage'
import {
  loadStoredViewedFiles,
  saveStoredViewedFiles,
  viewedFileStorageKey,
  type ViewedFileSignatures
} from './viewedFileStorage'

interface ReviewSession {
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ViewedFileSignatures
  setViewedFiles: Dispatch<SetStateAction<ViewedFileSignatures>>
}

// Draft comments and viewed marks belong to one review of one repository, and
// both outlive the window: they are restored on mount and saved on every change.
export function useReviewSession(root: string, reviewIdentity: string): ReviewSession {
  const threadStorageKey = reviewThreadStorageKey(root, reviewIdentity)
  const viewedStorageKey = viewedFileStorageKey(root, reviewIdentity)
  const [threadsByPath, setThreadsByPath] = useState<Record<string, ReviewThread[]>>(
    () => loadStoredReviewThreads(threadStorageKey)
  )
  const [viewedFiles, setViewedFiles] = useState<ViewedFileSignatures>(
    () => loadStoredViewedFiles(viewedStorageKey)
  )

  useEffect(() => {
    saveStoredReviewThreads(threadStorageKey, threadsByPath)
  }, [threadStorageKey, threadsByPath])

  useEffect(() => {
    saveStoredViewedFiles(viewedStorageKey, viewedFiles)
  }, [viewedFiles, viewedStorageKey])

  return { threadsByPath, setThreadsByPath, viewedFiles, setViewedFiles }
}
