---
name: repository-work
description: Command policy for routine development work in bt-erp-api-prototype — which commands to run without asking and which always need confirmation.
---

# Routine repository work

For normal development tasks, run safe, reversible, non-destructive commands directly. Do not ask for
confirmation for:

- Inspection: `pwd`, `ls`, `find`, `grep`/`rg`, `cat`, `head`/`tail`, `sed -n` (reading only), `wc`, `diff`.
- Git (read or local-safe): `git status`, `git diff`, `git log`, `git show`, `git branch`, `git fetch`;
  `git switch`/`git switch -c` when the task requires it and `git status --short` shows the switch is safe.
- Node/tests: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run dev` (local only).
- Docker (read-only): `docker compose ps`, `docker compose logs`, `docker compose config` (print env names only).
- Read-only HTTP: `curl` GET requests and health checks (e.g. `/health`, schema metadata endpoints), with the token
  never printed.
- Files in task scope: `mkdir`, `cp` for temporary copies/backups, creating and editing files the task covers.

## Always confirm first

Stop and ask before any risky, destructive or externally visible action:

- Deleting files or directories, except clearly temporary files the task itself generated.
- `git reset --hard`, `git clean`, force push, or rewriting published history (rebase/amend of pushed commits).
- Pushing to `master` (auto-deploys stage), restarting/rebuilding the stage container, or any production release.
- Any SQL outside the API's read-only code paths, any write to the replica, or anything that bypasses the
  read-only boundary.
- `npm run test:integration` or other live replica load (performance runs, wide scans).
- Dropping databases, deleting Docker volumes (`docker compose down -v`).
- Creating, rotating or deleting secrets or tokens; editing `.env` or stage env files.
- Adding or upgrading npm dependencies.
- Sending external communications (email, chat, issue/MR comments) or any other irreversible remote action.

When unsure whether an action is reversible, treat it as needing confirmation.
