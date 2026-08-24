# patch-notes — for turns that changed things

```
! fixed    epoch rendering as a percentage
+ added    range check on every percent
~ changed  cache write is atomic, per-uid
- removed  slow_floor, slow_types
⚠ known    terminal still folds below 80 cols
```

- One line per change, verb-first, present tense.
- `⚠ known` is not optional when something is left broken, skipped, or
  untested.
- Paths and identifiers as written, never reflowed.
