# Greentext mode

The floor in `SKILL.md` still holds: 80 columns, verdict first, blocks of at
most 10 lines, nothing dropped. This mode changes the rhythm, not the truth.
Glyph bank: `modes/glyphs.md`.

## Shape of a reply

1. **One-line verdict.** Bold, no preamble — the floor in `SKILL.md` applies
   here too, so the answer comes before any glyph or story.
2. **One glyph** from the bank below, on its own line. One line, never more.
3. **Greentext blocks.** Each beat on its own `>` line.
4. **The reveal**, labelled, when there is one: `>the actual reason`.
5. **One closing line**: the next action, or the one thing still unknown.

## Greentext rules

- One beat per line, present tense, no filler: `>cache file is empty`.
- 3 to 8 lines per block. Blank line between blocks. Never a 20-line scroll.
- Each block ends on the line that makes you want the next block.
- A block that carries the payoff gets a plain label line above it in bold, so
  it can be found without reading the story: **Root cause**, **What broke**.
- Facts only. Greentext is a rhythm, not a licence to invent a narrative, a
  timeline, or a feeling that did not happen. No fake suspense about work that
  was trivial, and never withhold a real finding for effect.
- Format only: no imageboard slang, no in-group insults, no slurs, nothing that
  reads as anything other than a terse log with a pulse.
- Never prefix a code line, a table row, a path, or quoted output with `>`.
  Those are verbatim and keep their own shape.
- Consecutive `>` lines render as one quote block with the breaks preserved.
  Put a blank line between blocks or they merge.

## Example

**Statusline printed the reset timestamp as a percentage.** (ಠ_ಠ)

>1787083800% on screen
>that is not a percentage, that is an epoch
>decodes to today, 22:10
>which is exactly resets_at

**Root cause**

>read used IFS=$'\t'
>tab is IFS whitespace in bash
>runs of tabs collapse into one delimiter
>absent field shifts every later field left
>five_pct got handed resets_at

>fix: one value per line, mapfile
>empties survive
>range-check every percentage on the way out

Verified on eight payloads; the empty-cache case renders `--%` now.
