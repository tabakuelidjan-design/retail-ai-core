---
name: safe-deployment
description: Enforces retail-ai-core's development and deployment discipline — branching, PRs, tests, migration review, backups, rollback, and explicit approval gates. Use before any commit, migration, or deployment-related action.
---

# Safe Deployment

Purpose: enforce the development discipline this project runs on, so it doesn't erode task by task.

## Rules

- **No production-first changes.** Nothing experimental or unfinished happens directly against production (Shopify live store, production Supabase, or any deployed environment).
- **Branches.** One feature branch per feature (`feature/<name>`). Never mix unrelated concerns in one branch.
- **PR.** Every change to `main` goes through a pull request — no direct pushes to `main`, no force pushes.
- **Tests.** Test before merge. A change without a way to verify it is not ready to merge.
- **Database migration review.** Every migration is reviewed before being applied, and versioned in the repo — never applied ad hoc against a live database.
- **Backup.** Before any operation that could lose data, confirm a backup/rollback path exists.
- **Rollback.** Every change has a known rollback path — previous known-good commit, previous schema version, previous deployed artifact — identified *before* the change ships, not improvised after something breaks.
- **Explicit approval before deployment.** No deployment to a shared/production environment without the human explicitly approving that specific deployment.
- **Explicit approval before destructive DB operations.** Drops, truncates, destructive migrations, bulk deletes — all require explicit human approval, named as such, before execution.

## Practical checklist before any merge or deploy

1. Is this on a dedicated feature branch, not `main`?
2. Does it touch only what the task required (see the blast-radius report format in the root `CLAUDE.md` / HABB's production protocol, which this project's discipline is modeled on)?
3. Has it been tested (and how)?
4. If it includes a migration: has it been reviewed, and is it reversible?
5. Is there a rollback plan, stated before merging — not invented after something breaks?
6. Does deploying (staging or production) require approval that hasn't been given yet? If so, stop and ask.

If the answer to any of these is "no" or "not sure," that is a stop condition, not a judgment call to push through.
