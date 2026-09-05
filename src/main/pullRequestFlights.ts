import type { PullRequestReview, PullRequestReviewProgress } from '../shared/contracts.js'

export type PullRequestProgressListener = (progress: PullRequestReviewProgress) => void

function deliver(listener: PullRequestProgressListener, progress: PullRequestReviewProgress): void {
  try {
    listener(progress)
  } catch {
    // One subscriber's failure — a window closed mid-send, say — must not stop the
    // fetch or starve the readers who are still watching the same review.
  }
}

/**
 * One fetch per pull request, however many callers ask for it.
 *
 * The clipboard warmup used to win the race to `#reviewFlights` and take the only
 * `onProgress` with it, so the reader who pressed Cmd+H a moment later joined a
 * silent promise: no metadata event, no streamed pages, the whole review landing
 * in a single burst at the end. A flight now records what it has emitted and
 * replays it to whoever joins next, so a late subscriber sees the same sequence a
 * first subscriber saw.
 */
export class PullRequestReviewFlight {
  /** Aborted once every caller that asked for this review has cancelled. */
  readonly abort = new AbortController()
  #requests = new Set<string>()
  #listeners = new Set<PullRequestProgressListener>()
  #metadata: PullRequestReviewProgress | null = null
  #pages: PullRequestReviewProgress[] = []
  #replace: PullRequestReviewProgress | null = null
  #checks: PullRequestReviewProgress | null = null
  #done: PullRequestReviewProgress | null = null
  #streamed = false
  #promise: Promise<PullRequestReview> | null = null

  /** True once any file page has been emitted, so the reply can drop its copy. */
  get streamed(): boolean {
    return this.#streamed
  }

  get promise(): Promise<PullRequestReview> {
    const promise = this.#promise
    if (promise == null) throw new Error('This pull request flight has not started.')
    return promise
  }

  start(
    run: (emit: PullRequestProgressListener) => Promise<PullRequestReview>
  ): Promise<PullRequestReview> {
    this.#promise ??= run((progress) => {
      this.#record(progress)
      // A snapshot, so a subscriber that leaves while the event is being delivered
      // cannot cut the fan-out short for the ones behind it.
      const listeners = Array.from(this.#listeners)
      for (const listener of listeners) deliver(listener, progress)
    })
    return this.promise
  }

  /**
   * Registers a caller that wants this review finished. A warmup deliberately does
   * not: it must never be the reason a fetch outlives the reader who cancelled it.
   */
  attach(requestId: string): void {
    this.#requests.add(requestId)
  }

  /** Cancels the fetch once the last caller that wanted it has gone. */
  detach(requestId: string): void {
    if (!this.#requests.delete(requestId)) return
    if (this.#requests.size === 0) this.abort.abort()
  }

  /** Adds a subscriber and hands it everything the flight has already emitted. */
  join(listener: PullRequestProgressListener | undefined): void {
    if (listener == null) return
    this.#listeners.add(listener)
    for (const progress of this.replay()) deliver(listener, progress)
  }

  release(listener: PullRequestProgressListener | undefined): void {
    if (listener == null) return
    this.#listeners.delete(listener)
  }

  settle(): void {
    this.#listeners.clear()
  }

  /** The event sequence a subscriber joining now has to see to be up to date. */
  replay(): PullRequestReviewProgress[] {
    const events: PullRequestReviewProgress[] = []
    if (this.#metadata != null) events.push(this.#metadata)
    // A replacement supersedes every page that preceded it, so a joiner is told
    // the current review once instead of a stale stream and then a correction.
    if (this.#replace != null) events.push(this.#replace)
    else events.push(...this.#pages)
    if (this.#checks != null) events.push(this.#checks)
    if (this.#done != null) events.push(this.#done)
    return events
  }

  #record(progress: PullRequestReviewProgress): void {
    if (progress.kind === 'metadata') {
      this.#metadata = progress
      return
    }
    if (progress.kind === 'files') {
      this.#pages.push(progress)
      this.#streamed = true
      return
    }
    if (progress.kind === 'replace') {
      this.#pages = []
      this.#replace = progress
      this.#streamed = true
      return
    }
    if (progress.kind === 'checks') {
      this.#checks = progress
      return
    }
    this.#done = progress
  }
}
