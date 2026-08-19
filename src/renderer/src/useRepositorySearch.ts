import {
  startTransition,
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
import { getSearchNavigationDirection, moveSearchResultIndex } from './searchNavigation'
import { contentSearchDelay } from './contentSearchScheduler'

const FILE_SEARCH_RESULT_LIMIT = 32

export interface RepositorySearchController {
  query: string
  fileResults: string[]
  contentResults: ContentSearchResult[]
  searchingContent: boolean
  isOpen: boolean
  activeResultIndex: number
  inputRef: React.RefObject<HTMLInputElement | null>
  setActiveResultIndex: React.Dispatch<React.SetStateAction<number>>
  changeQuery(query: string): void
  handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void
  selectResult(path: string): void
}

export function useRepositorySearch(
  snapshot: RepositorySnapshot | null,
  onSelectPath: (path: string) => void,
  onError: (message: string) => void
): RepositorySearchController {
  const [query, setQuery] = useState('')
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([])
  const [searchingContent, setSearchingContent] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRequestRef = useRef(0)
  const previousScheduledQueryRef = useRef('')
  const deferredQuery = useDeferredValue(query)
  const indexedPaths = useMemo(() => createFileSearchIndex(snapshot?.paths ?? []), [snapshot])
  const fileResults = useMemo(() => {
    if (snapshot == null || deferredQuery.trim() === '') return []
    return rankFilePaths(indexedPaths, deferredQuery, FILE_SEARCH_RESULT_LIMIT)
  }, [deferredQuery, indexedPaths, snapshot])
  const resultPaths = useMemo(
    () => [...fileResults, ...contentResults.map((result) => result.path)],
    [contentResults, fileResults]
  )
  const resolvedActiveIndex = resultPaths.length === 0
    ? -1
    : Math.min(Math.max(activeResultIndex, 0), resultPaths.length - 1)

  const selectResult = useCallback((path: string) => {
    startTransition(() => onSelectPath(path))
    setQuery('')
    setActiveResultIndex(-1)
    inputRef.current?.blur()
  }, [onSelectPath])

  const changeQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setContentResults([])
    setActiveResultIndex(nextQuery.trim() === '' ? -1 : 0)
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    const direction = getSearchNavigationDirection(event)
    if (direction !== 0) {
      event.preventDefault()
      setActiveResultIndex((currentIndex) => moveSearchResultIndex(currentIndex, resultPaths.length, direction))
      return
    }
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const selectedResult = resultPaths[resolvedActiveIndex]
      if (selectedResult != null) {
        event.preventDefault()
        selectResult(selectedResult)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      changeQuery('')
    }
  }, [changeQuery, resolvedActiveIndex, resultPaths, selectResult])

  useEffect(() => {
    const requestId = contentRequestRef.current + 1
    contentRequestRef.current = requestId
    if (query.trim().length < 2) {
      previousScheduledQueryRef.current = query
      setContentResults([])
      setSearchingContent(false)
      window.repository?.cancelContentSearch()
      return
    }

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
  }, [onError, query])

  return {
    query,
    fileResults,
    contentResults,
    searchingContent,
    isOpen: snapshot != null && query.trim().length > 0,
    activeResultIndex: resolvedActiveIndex,
    inputRef,
    setActiveResultIndex,
    changeQuery,
    handleKeyDown,
    selectResult
  }
}
