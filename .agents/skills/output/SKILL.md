---
name: output
description: Format replies so they actually get read - verdict first, narrow lines, short skimmable blocks, and a set of modes (layer-cake headings, BLUF, receipts, hook-loop, patch-notes, sparklines, quiz, greentext) chosen to fit the reply or named explicitly. Use when the user asks for narrower output, 80 columns, shorter lines, easier-to-skim or less-boring replies, greentext or 4chan style, changelog or patch-notes format, or invokes /output (optionally /output 4chan, /output bluf, /output 72). Persists for the rest of the session until turned off.
---

# Output

The reply that does not get read is worth nothing. Format for a skimming eye,
then pick the mode that fits what this particular reply has to say.

## Persistence

ACTIVE FOR EVERY RESPONSE from now on, not just the next one. It does not lapse
after a long conversation, a tool-heavy turn, or a topic change. If you are
unsure whether it is still active, it is. Only the user turns it off, with
"stop", "plain", or "full width".

## The floor, in every mode

**Verdict first.** Line one answers the question or states the outcome. No
preamble, no restating the request. A reader who stops after one line still got
what they came for. This outranks every mode below — nothing delays it.

**Width 80.** Wrap prose at 80 columns, flush left, ragged right, never padded
or justified. Count characters; aim for 76 when a line holds emoji or CJK, which
render two columns wide. `/output 72` sets a different width for the session.

**Blocks of 10 lines at most**, then a blank line. One claim, step, or finding
per block. Longer than that: split it or cut it.

**Front-load.** The first two words of every heading, bullet, and block carry
the information. Readers scanning the left edge see word one and two, rarely
word three.

**One glyph** per reply, on the verdict line or under it, from
`modes/glyphs.md`. Chosen by outcome, never repeated from the previous reply,
skipped on replies under five lines. One line, never a drawing.

## Never wrap or restyle

Verbatim, and may exceed the width: **code blocks** (an inserted break is a
syntax error), **table rows** (a newline destroys the row), **URLs, paths,
identifiers, error strings** (start on their own line, let them overrun), and
quoted terminal output, logs, diffs.

## Not a licence to say less

Formatting is not a length budget. Never drop detail, caveats, file references,
failures, or steps to make a reply look tidy — same content, shorter lines,
smaller blocks. Never trade accuracy for shape: a finding that needs a long
qualifier keeps the qualifier, on its own line. Where another active style rule
is more terse, that one wins.

## Choosing a mode

Pick from what the reply contains, not from habit, then read only that mode's
file — they are one per file so a reply loads what it uses and nothing else:

| The reply is | Mode | File |
| --- | --- | --- |
| long, mixed, several findings | **layer-cake** (default spine) | `modes/layer-cake.md` |
| answering one direct question or decision | **bluf** | `modes/bluf.md` |
| built on tool output, measurements, file reads | **receipts** (stack it) | `modes/receipts.md` |
| about work that changed files, shipped, released | **patch-notes** | `modes/patch-notes.md` |
| carrying two or more comparable numbers | **sparkline** (stack it) | `modes/sparkline.md` |
| a genuinely counter-intuitive finding | **quiz** (at most once) | `modes/quiz.md` |
| a real story with a twist, or fun was asked for | **hook-loop** | `modes/hook-loop.md` |
| short — under about eight lines | none; just the floor | — |

The table is enough to choose. Open a mode file when you are writing in it, not
to decide whether to.

Stack at most **one spine** (layer-cake, bluf, hook-loop) with up to **two
add-ons** (receipts, sparkline, patch-notes, quiz). A mode that would add words
without adding signal is the wrong mode: drop it.

**Explicit beats inferred.** `/output 4chan` (see `modes/greentext.md`),
`/output bluf`, `/output patch-notes` and so on lock that mode for the session
until the user names another. Without a name, choose per reply.
