// Pure bookkeeping for the probes: first-seen times for a set of conditions and
// the digest of a pull request's progress stream. Kept out of the probe scripts
// so it can be tested without launching the app.

/**
 * Records the first moment each condition was observed and ignores every later
 * sighting. A probe that polls one expression can then time several conditions
 * from the same round trip instead of waiting for them one after another.
 */
export function createTimeline(startedAt) {
  const seen = new Map()
  return {
    /** Records `name` if it has not been seen; returns its offset either way. */
    mark(name, at = Date.now()) {
      if (!seen.has(name)) seen.set(name, at - startedAt)
      return seen.get(name)
    },
    /** Records `name` only when `condition` holds. */
    markIf(name, condition, at = Date.now()) {
      return condition ? this.mark(name, at) : this.at(name)
    },
    at(name) {
      return seen.has(name) ? seen.get(name) : null
    },
    has(name) {
      return seen.has(name)
    },
    /** Every condition seen so far, in the order it first appeared. */
    entries() {
      return Object.fromEntries(seen)
    }
  }
}

// A page carries the files it parsed; `metadata`, `done`, and the events later
// waves add (`replace`, `checks`) do not. Keying on the payload rather than on a
// list of kinds means a new kind cannot silently become "the first page".
function isFilePage(event) {
  return typeof event?.files === 'number'
}

/**
 * Folds the recorded `onPullRequestReviewProgress` events into the moments the
 * targets are stated in: metadata, the first file page and done, plus the first
 * sighting of every kind seen — including kinds this probe does not know about.
 */
export function summarizePullRequestProgress(events, startedAt) {
  const ordered = [...(events ?? [])].sort((left, right) => left.t - right.t)
  const kinds = new Map()
  for (const event of ordered) {
    const existing = kinds.get(event.kind)
    if (existing == null) kinds.set(event.kind, { kind: event.kind, ms: event.t - startedAt, count: 1 })
    else existing.count += 1
  }
  const metadata = ordered.find((event) => event.kind === 'metadata') ?? null
  const firstPage = ordered.find(isFilePage) ?? null
  const done = ordered.find((event) => event.kind === 'done') ?? null
  const counted = [...ordered].reverse().find((event) => typeof event.fileCount === 'number') ?? null
  return {
    metadataMs: metadata == null ? null : metadata.t - startedAt,
    firstPageMs: firstPage == null ? null : firstPage.t - startedAt,
    doneMs: done == null ? null : done.t - startedAt,
    fileCount: counted?.fileCount ?? null,
    progressKinds: [...kinds.values()]
  }
}
