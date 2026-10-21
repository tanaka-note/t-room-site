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
5. If production release is within the user's authorization, release only the affected service through the documented path. In Codex Cloud, prefer the existing GitHub Actions production path: merge the verified change into main with the connected GitHub tools and follow the main run through production verification. Missing local Wrangler credentials do not prevent this path. For an explicit retry of unchanged main, use the documented workflow_dispatch with production_target; never simulate GitHub Actions environment variables to run release-actions.mjs outside Actions. The release commands verify committed build freshness for every app on the deploy target before Wrangler runs and read production back afterward; do not bypass either check or prepare an isolated release worktree with ad-hoc dependency links or installs. Do not treat a GitHub push or a green verification-only run as deployment. Downloader and services with special release procedures must use their documented workflow.
6. Read back the deployed target and confirm the production build or version matches the released commit as described in `docs/development-flow.md`.

Stop and request direction under the conditions in `AGENTS.md`, especially destructive production-data operations or changes to authentication, encryption, or key management. Never weaken those conditions to complete a release.

Report the commit, pushed branch, released targets, build/version confirmation, checks run and their results, and any intentionally omitted high-cost checks.
