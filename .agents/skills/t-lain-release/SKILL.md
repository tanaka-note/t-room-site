---
name: t-lain-release
description: Verify, commit, push, and release a T-lain repository change using the smallest affected-service workflow. Use when a user asks to finish, publish, deploy, or release changes in this repository.
---

# T-lain release

Read the repository root `AGENTS.md` and `docs/development-flow.md` before acting. Treat them as the source of truth; do not copy their detailed commands or service rules into this skill.

1. Inspect the branch, worktree, and diff. Protect unrelated or pre-existing changes and identify the services actually affected.
2. Run `npm run verify:plan` and review its proposed targets. Execute only the relevant verify commands plus any focused regression required by the change. Do not run whole-repository, repeated, browser, Container, Queue, R2, or production tests without a change-specific reason.
3. Confirm the selected local checks and applicable CI completed successfully. Distinguish failures, skips, unavailable checks, and checks not run.
4. Stage and commit only the files in scope, then push the intended branch. Do not overwrite unrelated remote work.
5. If production release is within the user's authorization, release only the affected service through the documented path. Do not treat a GitHub push as deployment. Downloader and services with special release procedures must use their documented workflow.
6. Read back the deployed target and confirm the production build or version matches the released commit as described in `docs/development-flow.md`.

Stop and request direction under the conditions in `AGENTS.md`, especially destructive production-data operations or changes to authentication, encryption, or key management. Never weaken those conditions to complete a release.

Report the commit, pushed branch, released targets, build/version confirmation, checks run and their results, and any intentionally omitted high-cost checks.
