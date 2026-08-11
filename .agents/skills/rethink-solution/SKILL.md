---
name: rethink-solution
description: Force a rigorous second pass over a completed or substantially implemented solution to expose shortcuts, accidental complexity, missing requirements, weak architecture, and fragile validation. Use after building or fixing something and before declaring it done, especially when the result works but may be messy, overbuilt, underbuilt, brittle, or based on the easiest path; also use when asked to rethink, reconsider, simplify, harden, challenge, or critically review an implementation or architecture. Applies to code, plans, designs, configurations, workflows, and technical decisions.
---

# Rethink Solution

Perform an independent second design pass. Treat “it works” as necessary but not sufficient. Seek the simplest solution that fully satisfies the real requirements and remains maintainable.

## Reconstruct the target

1. Restate the required outcome, constraints, invariants, and likely failure modes from the source request and available evidence.
2. Separate explicit requirements from assumptions. Do not invent new scope merely to improve the solution.
3. Inspect the actual artifact, relevant surrounding system, and validation results. Do not review only a summary of the work.

## Challenge the solution

Re-derive a reasonable approach as if the existing solution did not exist, then compare it with what was built.

Press on each question:

- Does every requirement hold in behavior, including edge cases and failure paths?
- Was a shortcut used that only hides, postpones, or relocates the problem?
- Is the architecture appropriate to the problem's actual size and expected change?
- Is any abstraction, dependency, state, branch, step, or layer unnecessary?
- Is anything missing that correctness, security, reliability, accessibility, performance, or maintainability genuinely requires?
- Are responsibilities and boundaries clear, with one source of truth and no avoidable duplication?
- Could a materially simpler implementation provide the same guarantees?
- Do tests or checks prove the outcome, or merely exercise the happy path?

Use concrete evidence from the artifact. Distinguish defects from preferences.

## Diagnose architectural pathologies

Use precise engineering vocabulary when it makes a finding more exact. Examine the solution for:

- **Accidental complexity:** Structure that the problem does not inherently require.
- **Leaky abstraction:** An interface that forces callers to understand concealed implementation details.
- **Temporal coupling:** Operations that work only when they occur in an undocumented order or time window.
- **Hidden state:** Behavior controlled by state that is not visible at the relevant boundary.
- **Shotgun surgery:** One conceptual change that requires edits across many unrelated locations.
- **Semantic drift:** Names, types, documentation, tests, and behavior that no longer express the same meaning.
- **Invariant erosion:** A rule that should always hold but is enforced inconsistently or only by convention.
- **Failure non-atomicity:** A partial operation that leaves corrupt, ambiguous, or unrecoverable state.
- **Non-idempotent retry behavior:** Repeating an operation unexpectedly duplicates or compounds its effects.
- **Unbounded blast radius:** A local failure or change can affect more of the system than necessary.
- **Observability gap:** The system cannot reveal why a material failure occurred.
- **Premature generalization:** An abstraction designed for hypothetical variation instead of demonstrated needs.

Do not use sophisticated terminology as decoration. For each term, identify the concrete mechanism, consequence, and affected artifact. Use plain language alongside uncommon terms in user-facing reports.

## Decide proportionally

Classify each finding:

- **Must fix:** Violates a requirement or creates a credible correctness, security, data-loss, or operational risk.
- **Should fix:** Adds meaningful fragility, complexity, duplication, or maintenance cost.
- **Leave alone:** A stylistic preference, speculative future need, or rewrite whose benefit does not justify its risk.

Prefer the smallest coherent correction. Do not replace working code merely to make it different, introduce abstractions for hypothetical reuse, or broaden the task without authorization.

## Act and verify

When the task authorizes changes, fix all must-fix findings and worthwhile should-fix findings within scope. Re-run the strongest relevant checks and inspect the final diff or artifact for accidental complexity and regressions.

When the task is review-only, report findings without modifying the artifact.

Conclude with one of these evidence-backed outcomes:

- **Revised:** State what was materially wrong, what changed, and how it was verified.
- **Sound as written:** State why the current approach is the simplest adequate solution and name the alternatives considered and rejected.
- **Blocked:** State the missing evidence or decision required; never claim confidence that the available evidence cannot support.

Never rubber-stamp the first solution. Never manufacture criticism solely to justify a rewrite.
