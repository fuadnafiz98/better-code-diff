---
name: review-comments
description: Review and clean comments or docstrings in recently changed code. Use when comments are noisy, redundant, obvious, outdated, task- or ticket-specific, agent-generated, over-explanatory, or unlikely to survive long-term maintenance; when preparing a diff for review or commit; or when asked to remove comment noise, rewrite comments to explain why, make code self-explanatory, or invoke /review-comments. Default to changed files and changed lines, never a whole-repository sweep unless explicitly requested.
license: MIT
metadata:
  author: "Md. Muhtasim Fuad"
  github: "https://github.com/fuadnafiz98"
---

# Review Comments

Treat every comment as permanent maintenance cost. Keep it only when its durable value exceeds that cost.

Prefer code that explains itself. Use comments to preserve information that cannot be expressed clearly in names, types, structure, tests, assertions, or APIs.

## Establish scope

1. Inspect repository instructions before reviewing.
2. Default to the current Git changes: staged, unstaged, and untracked source files. If these are empty, inspect the branch diff against the repository's evident base branch.
3. Focus on added or modified lines. Include a nearby existing comment only when changed code makes it inaccurate, misleading, redundant, or necessary to understand the change.
4. Do not sweep untouched legacy code or the whole repository unless explicitly requested.
5. Exclude generated files, vendored sources, lockfiles, snapshots, minified files, and third-party code unless explicitly included.
6. Preserve license headers, attribution, required generated-file warnings, and repository-mandated notices.

If staged and unstaged changes both exist, inspect both unless the user names a narrower surface. State the chosen surface; ask only when choosing incorrectly could change or overwrite work outside the requested scope.

If the user requests review only, report proposed changes without editing. If the user requests cleanup, rewriting, fixing, or implementation, apply the changes.

## Build context before judging

Never judge a comment in isolation. Read enough surrounding code, call sites, tests, types, configuration, and documentation to determine:

- What the code actually guarantees
- What a maintainer can infer from code alone
- Which behavior is intentional rather than accidental
- Which constraint, tradeoff, or failure mode shaped the implementation
- Whether the comment describes the current code
- Whether its claimed rationale is supported by evidence

Use version history only when the rationale remains unclear. Do not preserve task narration merely because it appears in a commit, pull request, or ticket.

Never invent a reason. If the rationale cannot be established, delete a redundant comment or flag a potentially important but unsupported claim for clarification.

## Classify each comment

Choose one outcome:

- **Keep**: accurate, durable, useful, and not reasonably expressible in code
- **Rewrite**: contains valuable knowledge but emphasizes mechanics, chronology, vague warnings, or temporary task context
- **Delete**: redundant, obvious, stale, speculative, misleading, decorative, or task-specific
- **Convert**: preserve the information more reliably in code, a name, type, assertion, test, validation rule, public documentation, or issue tracker
- **Clarify**: a consequential constraint may exist, but repository evidence is insufficient to state it safely

Do not rewrite every bad comment. Deletion is often the correct repair.

## Apply the survival test

Keep or write a comment only when it passes these questions:

1. Is it still useful after the current task, ticket, pull request, and author are forgotten?
2. Does it preserve information the code cannot communicate clearly?
3. Does it explain a reason, constraint, tradeoff, invariant, hazard, or non-obvious consequence?
4. Is it accurate for the code as it exists now?
5. Will it remain true through ordinary refactoring?
6. Is it specific enough to guide a future change?
7. Can it be stated without guessing at intent?

If a critical answer is no, delete, rewrite, convert, or clarify it.

## Write for humans and agents

Make every retained or rewritten comment readable by both human maintainers and coding agents:

- Use plain, direct language with enough local context to stand on its own.
- Name the concrete constraint, invariant, risk, or consequence instead of relying on implied intent.
- Preserve established domain terminology so humans and agents can search for related concepts.
- Avoid phrasing that depends on task history, author knowledge, human intuition, or agent-specific context.
- Never use em dashes in comments or docstrings. Replace them with a period, comma, colon, semicolon, or parentheses, whichever expresses the relationship most clearly.
- Remove existing em dashes from every comment or docstring within the review scope, even when the surrounding comment is otherwise retained unchanged.

Do not alter em dashes in strings, user-facing copy, documentation, or untouched code unless the user explicitly expands the scope.

## Delete noise

Delete comments that merely:

- Translate syntax into prose
- Repeat a name, signature, type, branch, loop, or return value
- Narrate execution step by step
- Announce that code was added, changed, fixed, moved, or requested
- Mention "this task," "this ticket," "this PR," or an agent's work instead of the enduring reason
- Record temporary implementation chronology
- Add decorative banners or headings where code structure is already clear
- Promise behavior the code does not enforce
- Explain conventional language or framework behavior
- Say "for safety," "important," "careful," "hack," or "workaround" without naming the concrete risk
- Contain unsupported guesses such as "probably" or "should"
- Preserve dead alternatives or commented-out code
- Duplicate nearby documentation
- Describe a test that its name and assertions already explain

Example:

```ts
// Loop through every user.
for (const user of users) {
```

Delete the comment.

```ts
// Added this check to fix the login ticket.
if (!session) {
```

Delete it unless repository evidence reveals a non-obvious invariant worth preserving.

## Prefer fixing the code

When a comment compensates for confusing code, make the smallest behavior-preserving improvement that removes the need for it:

- Rename vague identifiers
- Extract a well-named variable, predicate, or function
- Simplify needlessly indirect control flow
- Replace a prose claim with a type, assertion, or validation rule
- Express regression behavior in a test name and assertions

Do not use comment cleanup as permission for broad refactoring. If clearer code would require a risky or unrelated redesign, keep one concise rationale comment or report the opportunity separately.

## Preserve durable rationale

Useful comments commonly explain:

- Non-obvious business rules
- Invariants spanning multiple operations
- Compatibility, protocol, browser, platform, compiler, or dependency constraints
- Security boundaries and the concrete threat being mitigated
- Concurrency, ordering, atomicity, or reentrancy requirements
- Measured performance tradeoffs
- A deliberate deviation from the obvious implementation
- Why an apparently redundant operation must remain
- Units, coordinate systems, encodings, normalization, or precision assumptions
- Destructive or irreversible consequences
- Public API behavior that types cannot fully express
- Why a lint, type, safety, or coverage rule is narrowly suppressed
- Durable references to authoritative specifications or upstream defects

Write the narrowest comment that preserves the knowledge.

Prefer this shape:

```text
<Constraint or reason>. <Consequence if changed or removed, when useful>.
```

Examples:

```ts
// The provider rejects retries made less than one second apart.
await delay(1000);
```

```ts
// Preserve insertion order because the first matching rule wins.
```

```ts
// Force layout so Safari applies the initial style before the transition starts.
void element.offsetHeight;
```

Do not mention the originating task when the underlying reason can stand on its own.

## Handle special cases

### TODO, FIXME, and HACK

Keep one only when it records actionable work that cannot be completed now. Require the unresolved condition, why it remains, and a removal condition or next action. Include an issue reference only when known and useful under repository convention.

Delete vague reminders such as `TODO: improve this`. Never invent owners, dates, plans, or issue identifiers.

### Tool directives and suppressions

Before editing, determine whether a comment is consumed by a compiler, formatter, linter, type checker, test runner, coverage tool, documentation generator, bundler, or code generator.

Preserve required machine-readable syntax. For suppressions, verify necessity, narrow the scope, and retain a concrete explanation of the false positive or required exception when the tool permits it.

### Public API documentation

Retain documentation required by the language, framework, or repository. Describe caller-visible contracts: preconditions, errors, side effects, units, formats, ownership, lifecycle, and concurrency guarantees. Do not restate the signature.

### Tests

Prefer descriptive test names, helpers, and assertions. Keep comments for non-obvious setup constraints, intentionally omitted assertions, timing behavior, or regression rationale that cannot be expressed cleanly in the test.

### Algorithms and regular expressions

Improve names and structure first. If complexity remains irreducible, explain the accepted language, invariant, or design choice rather than narrating tokens or steps.

### External references

Prefer stable, authoritative links for specifications and upstream defects. State the durable constraint locally so the comment remains useful if the link breaks. A ticket reference may supplement rationale but must not replace it.

### Security and operational warnings

Name the actual hazard and boundary being protected. Do not expose secrets, customer data, exploit details, private incidents, or sensitive infrastructure information.

### Examples and annotations

Do not remove doctests, executable examples, documentation annotations, coverage directives, generated-code markers, localization notes, accessibility annotations, or schema/tool inputs merely because they resemble prose. Verify their semantic role.

## Resolve edge cases deliberately

Before changing an ambiguous comment, ask internally:

1. Is this prose machine-readable or required by tooling?
2. Is apparent repetition required public documentation?
3. Does it stop a future maintainer from "simplifying" deliberate behavior?
4. Does its reason depend on a caller, test, schema, protocol, or external system?
5. Is the comment stale, or is the code violating a documented invariant?
6. Can a name, structure, assertion, type, test, or validation rule preserve the knowledge better?
7. Does a ticket contain useful rationale that must be restated locally?
8. Does the comment preserve searchable domain terminology?
9. Could deletion lose accessibility, localization, security, compliance, compatibility, or operational knowledge?
10. Is the unusual implementation deliberate or merely accidental complexity?
11. Can the rationale be proven from repository evidence?
12. Would the rewrite become overconfident if evidence is incomplete?
13. Will the wording survive renaming, extraction, branch reordering, and routine refactoring?
14. Does the comment describe what happens, why it must happen, or merely what the author just did?

When material uncertainty remains, avoid a destructive rewrite. Report the ambiguity and the evidence needed to resolve it.

## Edit conservatively

1. Preserve behavior.
2. Touch only reviewed comments and the smallest code changes needed to make them unnecessary.
3. Avoid unrelated formatting or refactoring.
4. Preserve directive syntax and repository style.
5. Re-read every retained or rewritten comment against the final code.
6. Run relevant formatting, linting, documentation generation, or tests when comments or adjacent code can affect tooling.
7. Inspect the final diff for accidental code changes and scope expansion.

## Report the result

Summarize briefly:

- What was deleted as noise
- What was rewritten to preserve rationale
- What was converted into clearer code, tests, types, or assertions
- What was intentionally retained and why
- What remains ambiguous
- What validation was performed

For review-only requests, report actionable findings in priority order with exact locations and suggested replacements. Explain maintenance risk or lost rationale rather than judging style alone.
