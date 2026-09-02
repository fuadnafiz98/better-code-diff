import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import type { ContentSearchResult, RepositorySnapshot } from '../../shared/contracts'
import { createFileSearchIndex, rankFilePaths } from './fileSearch'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import { contentSearchDelay } from './contentSearchScheduler'

const FILE_SEARCH_RESULT_LIMIT = 32

export interface RepositorySearchController {
  query: string
  fileResults: string[]
  contentResults: ContentSearchResult[]
  searchingContent: boolean
  changeQuery(query: string): void
}

export function useRepositorySearch(
  snapshot: RepositorySnapshot | null,
  onError: (message: string) => void
): RepositorySearchController {
  const [query, setQuery] = useState('')
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([])
  const [searchingContent, setSearchingContent] = useState(false)
  const contentRequestRef = useRef(0)
  const previousScheduledQueryRef = useRef('')
  const deferredQuery = useDeferredValue(query)
  const hasSnapshot = snapshot != null
  const snapshotPaths = snapshot?.paths
  const searching = deferredQuery.trim() !== ''
  const indexedPaths = useMemo(
    () => searching ? createFileSearchIndex(snapshotPaths ?? []) : [],
    [searching, snapshotPaths]
  )
  const fileResults = useMemo(() => {
    if (snapshot == null || !searching) return []
    return rankFilePaths(indexedPaths, deferredQuery, FILE_SEARCH_RESULT_LIMIT)
  }, [deferredQuery, indexedPaths, searching, snapshot])

  const changeQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setContentResults([])
  }, [])

  useEffect(() => {
    const requestId = contentRequestRef.current + 1
    contentRequestRef.current = requestId
    if (query.trim().length < 2) {
      previousScheduledQueryRef.current = query
      setContentResults([])
      setSearchingContent(false)
      if (hasSnapshot) window.repository?.cancelContentSearch()
      return
    }

    if (!hasSnapshot) return

    setContentResults([])
    setSearchingContent(true)
    window.repository?.cancelContentSearch()
    const delay = contentSearchDelay(previousScheduledQueryRef.current, query)
    previousScheduledQueryRef.current = query
    const timeout = window.setTimeout(() => {
      void requireRepositoryApi()
        .searchContent(query)
        .then((results) => {
          if (contentRequestRef.current === requestId) setContentResults(results)
        })
        .catch((searchError: unknown) => {
          if (contentRequestRef.current === requestId) onError(getErrorMessage(searchError))
        })
        .finally(() => {
          if (contentRequestRef.current === requestId) setSearchingContent(false)
        })
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [hasSnapshot, onError, query])

  return useMemo(() => ({
    query,
    fileResults,
    contentResults,
    searchingContent,
    changeQuery
  }), [changeQuery, contentResults, fileResults, query, searchingContent])
}
