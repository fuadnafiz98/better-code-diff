---
name: resolve-conflicts
description: Safely resolve all conflicts in an in-progress Git rebase or merge while preserving the target branch's current structure and reapplying the incoming change's intent. Use when Git stops on conflicts; when the user says "resolve conflicts", "resolve conflict", or "fix the rebase"; or when the user invokes /resolve-conflict or /resolve-conflicts, optionally with a target branch such as "on dev" or "dev".
---

# Resolve conflicts

Resolve every conflict in an in-progress rebase or merge. Preserve the target branch's current structure, then reapply the incoming change's intent where it is still relevant.

Treat a branch supplied in the request, such as `/resolve-conflict on dev` or `/resolve-conflicts dev`, as the expected target branch. Verify that expectation against the active Git operation. Do not start a new rebase or merge.

## Establish the Git state

1. Read repository instructions and run `git status --short --branch` plus `git status`.
2. Confirm that a rebase or merge is active. Stop and report if neither operation is active.
3. Record all initial staged, unstaged, and untracked paths. Preserve unrelated user changes.
4. List unresolved index entries with `git diff --name-only --diff-filter=U` and `git ls-files -u`. Do not rely on conflict markers alone; modify/delete, rename, binary, mode, and submodule conflicts might have none.
5. Identify the commits and their roles before editing:
   - For a merge, inspect `HEAD`, `MERGE_HEAD`, their branch names when available, and their merge base.
   - For a rebase, inspect `HEAD`, `REBASE_HEAD`, the rebase status, and the configured onto/upstream commit when available. During a rebase, Git's `ours` is normally the rebased upstream state and `theirs` is the commit being replayed.
   - Resolve the expected target branch from the user's argument when one was supplied. Verify that it exists and matches the operation's target or onto history.
6. Do not infer semantic roles from the labels `ours`, `theirs`, `current`, or `incoming`. If the target and incoming roles remain ambiguous, stop and ask the user.

## Resolve each conflict

1. Inspect every unresolved path and its index stages. For text conflicts, locate all three marker types and read enough surrounding code and history to understand both intentions.
2. Classify each conflict:
   - **Target supersedes incoming**: keep the target behavior when it already implements the incoming intent better.
   - **Incoming only**: reapply the incoming behavior when the target does not provide it.
   - **Both add distinct behavior**: use the target version as the structural skeleton and integrate the incoming branches or cases.
   - **Incoming refactors target behavior**: preserve the target behavior through the incoming abstraction without duplicated logic.
   - **Non-text conflict**: inspect both objects and repository conventions. Do not choose or delete a binary, submodule, renamed, or modify/delete path without evidence of intent.
3. Inspect common lines outside text markers. They can constrain the correct result.
4. Edit only conflicted paths and necessary adjacent lines. Preserve unrelated changes present before the operation.
5. Verify that referenced helpers, imports, props, types, translations, generated artifacts, and parallel implementations exist and remain consistent.
6. Report briefly for each conflict: the path, each side's intent, the selected resolution, and the reason.

## Verify and continue

1. Search the resolved paths for all three conflict markers.
2. Run repository-defined, relevant checks for the affected code. Prefer focused formatting, linting, type checks, and tests. Do not assume a TypeScript project.
3. Review the diff against the recorded initial state. Do not fix unrelated or clearly pre-existing failures; report them with evidence.
4. Stage only the confirmed resolved paths with explicit path arguments.
5. Require both `git diff --name-only --diff-filter=U` and `git ls-files -u` to return no entries before continuing.
6. Run `GIT_EDITOR=true git rebase --continue` or `GIT_EDITOR=true git merge --continue`, as applicable. A continuation can stop on the next conflicted commit; repeat this workflow until the operation finishes.
7. Run relevant final checks, report the resulting branch and ahead/behind state, and stop.

## Safety rules

- Never use whole-file `git checkout --ours`, `git checkout --theirs`, `git restore --ours`, or `git restore --theirs` as a shortcut.
- Never skip a conflicted commit, abort the operation, discard changes, delete an uncertain path, amend unrelated work, or use destructive reset commands unless the user explicitly requests that action.
- Never push unless the user explicitly asks. Never force-push without separate explicit authorization.
- Never claim that marker-free files mean the index is conflict-free.
