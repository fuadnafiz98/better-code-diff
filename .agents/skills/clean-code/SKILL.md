---
name: clean-code
description: Review and clean up code changed during the current task for clear naming, sensible dependency placement, simple structure, and maintainability while preserving behavior. Use after implementing or modifying code; before handing work back, committing, or requesting review; or when asked to polish, simplify, refactor, or check current changes. Default to files and lines changed in the current task, not a repository-wide cleanup.
---

# Clean Code

Improve only the code changed in the current task. Preserve behavior, public APIs, and repository conventions. Favor small, evident improvements over speculative abstractions or broad rewrites.

## Establish scope

1. Read repository instructions and determine which changes belong to the current task from conversation context and version-control diffs.
2. Inspect staged, unstaged, and relevant untracked files. Distinguish task changes from pre-existing user changes; never claim or rewrite unrelated work.
3. Focus on added or modified lines. Touch nearby code only when needed to understand the change or make a safe, coherent cleanup.
4. Exclude generated files, vendored code, lockfiles, snapshots, minified files, and third-party sources unless explicitly included.
5. If the user asks only for a review, report actionable findings with file and line references without editing. If they ask to clean up, finish, polish, or implement, apply safe fixes.

If the task boundary remains ambiguous and editing could overwrite unrelated work, stop and ask for clarification. Otherwise, state the chosen scope and proceed.

## Review in context

Read enough surrounding code, call sites, tests, types, configuration, and documentation to understand behavior and local conventions. Use history only when the current code and task context do not explain an important choice.

Prioritize changes that make the edited code easier to understand, modify, and verify:

- Replace vague names such as `i`, `d`, `x`, `tmp`, or `val` with names that reveal their role or domain meaning.
- Name loop variables after the item or index being processed, such as `user`, `order`, `columnIndex`, or `retryCount`.
- Keep short names only when they are established domain conventions and genuinely clearer.
- Keep functions focused on one responsibility. Extract helpers only when they clarify intent or remove meaningful duplication.
- Prefer guard clauses and direct control flow over deep nesting.
- Remove dead code, unused imports, redundant branches, and comments that merely restate the code.
- Replace unexplained literals with named constants when the value has domain meaning or is reused.
- Make side effects and mutation obvious. Prefer immutable values when mutation provides no benefit.
- Handle errors where useful context can be added or recovery is possible. Do not silently swallow failures.

## Place dependencies deliberately

- Keep shared dependencies, types, macros, side-effect imports, and language-required static imports at file scope.
- When a dependency is used by one function, prefer a local import only if the language and project conventions support it and it improves ownership or load behavior.
- Do not move an import locally when doing so introduces repeated hot-path work, changes initialization or asynchronous behavior, hides a circular-import workaround, or conflicts with tooling.
- Group local imports at the start of the function before executable logic; do not scatter them through the body.

## Preserve behavior

- Preserve public APIs, observable behavior, error semantics, ordering, timing, and side effects unless the task explicitly authorizes a change.
- Do not disguise product changes, bug fixes, dependency upgrades, or performance rewrites as cleanup.
- Avoid unrelated formatting, new dependencies, speculative generalization, and abstractions with only one unclear use.
- Match clear and consistent repository patterns even when another style could also work.
- When a tempting cleanup carries meaningful semantic risk, leave it unchanged and report it as a follow-up opportunity.

## Verify the result

1. Review the final diff for scope expansion, unnecessary churn, accidental behavior changes, and edits to pre-existing work.
2. Run the narrowest relevant formatter, linter, type check, and tests available for the changed surface.
3. Do not broaden fixes merely to make unrelated pre-existing checks pass. Report unrelated failures separately.
4. Summarize meaningful cleanup, verification performed, and remaining risks. Do not list trivial formatting changes.
