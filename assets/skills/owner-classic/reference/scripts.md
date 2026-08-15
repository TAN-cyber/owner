# Stable Public CLI Contract

Canonical path: `owner-classic/reference/scripts.md`

This file is the single source of truth for Classic Skill calls into the Owner Runtime. Skills use only the public `owner` CLI on PATH. The packaged `owner/scripts/*.mjs` files are internal installation and Runtime assets; Skills do not search for or invoke them directly.

## CLI bootstrap

When entering a workflow, run the required public `owner` command below directly. If it returns `command not found`, `executable not found`, or `ENOENT`, stop and explain that the Owner CLI installation is incomplete. Do not search for Skill files, enumerate platform directories, or invoke an internal bundle directly. If the CLI starts but exits nonzero, report the original error and do not retry through an internal script.

## Public workflow contract

Everyday workflows use the public CLI:

```bash
owner classic workspace prepare <change-name> --isolation <current|branch|worktree> --json
owner classic workspace resolve <change-name> --json
owner state select <change-name>
owner state current
owner state clear-selection
owner state check <change-name> <phase>
owner guard <change-name> <phase> --apply
owner handoff <change-name>
owner archive <change-name>
owner resume-probe . --stdin --json
owner classic intent route --stdin
```

During Open, run workspace prepare first; when resuming, run workspace resolve, which scans registered Worktrees and returns the `projectRoot` to enter. Then run `owner state select <change-name>`. Ordinary source writes are governed only by that selection; without one, the hook blocks and asks for a choice. A single active change retains automatic routing. Run resolve and select again after switching branch/worktree or when the recorded selection becomes stale.

Guard `--apply` advances state after checks pass. Use `owner state transition` when expressing a state event directly, and `owner state next` after phase advancement to determine whether to invoke the next Skill automatically.

## Automatic state updates

Guard supports `--apply`, which updates `.owner.yaml` state fields after checks pass:

```bash
owner guard <change-name> <phase> --apply
```

`--apply` delegates to the state-machine transition. Use these semantic events when state changes need to be expressed directly:

```bash
owner state transition <change-name> open-complete
owner state transition <change-name> design-complete
owner state transition <change-name> build-complete
owner state transition <change-name> verify-pass
owner state transition <change-name> verify-fail
owner state transition <change-name> archive-confirm
owner state transition <change-name> archive-reopen
owner state transition <change-name> archived
owner state transition <change-name> preset-escalate
```

Archive completion is handled by `owner archive <change-name>` after OpenSpec moves the change into its date-prefixed archive directory. Use `archive-confirm` or `archive-reopen` for the pre-archive decision, and do not manually run the `archived` transition outside that flow.

## Resolve the next action

After guard-based phase advancement, use the `next` subcommand to determine whether to invoke the next Skill automatically:

```bash
owner state next <change-name>
```

Output format: `NEXT: auto|manual|done` + `SKILL: <skill-name>` (omitted for `done`) + `HINT` (for `manual` only). With `auto_transition: false`, output is `manual`, which pauses only the next Skill invocation and does not block phase updates.

## Archive command

Complete all archive steps with:

```bash
owner archive <change-name>
```
