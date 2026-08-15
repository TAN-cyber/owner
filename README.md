# Owner

[中文文档](./README-zh.md)

Owner is a resumable vibe-coding workflow for Claude Code and Codex. It turns an AI coding request into a persisted, guarded lifecycle with requirement shaping, implementation, evidence-backed verification, bounded repair, recovery, and archive.

Owner provides two independent workflows:

- **Loop**: `Shape → Build ↔ Verify → Archive`. A self-contained runtime for strong autonomous models. It does not depend on OpenSpec or Superpowers.
- **Pipeline**: `Open → Design → Build → Verify → Archive`. OpenSpec owns WHAT, Superpowers owns design/TDD/debug/review methods, and Owner owns orchestration, guards, recovery, and archive.

Supported hosts:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex/skills)

Owner is distributed under the MIT License. See [LICENSE](./LICENSE).

## Requirements

- Node.js 22+
- npm or pnpm
- Git
- Claude Code or Codex
- Network access for Pipeline dependencies (OpenSpec and Superpowers)

## Install from GitHub

After publishing the repository, replace `<YOUR_GITHUB_USER>`:

```bash
npm install -g git+https://github.com/<YOUR_GITHUB_USER>/owner.git
owner --version
```

Installing the CLI does not modify a host configuration. Owner writes Skills, Rules, and Hooks only after the user explicitly runs `owner init`.

## Initialize

Codex with both workflows:

```bash
owner init /path/to/project \
  --scope project \
  --platform codex \
  --workflow both
```

Claude Code with Loop:

```bash
owner init /path/to/project \
  --scope project \
  --platform claude \
  --workflow loop
```

Global installation is explicit:

```bash
owner init --scope global --platform codex --workflow both
owner init --scope global --platform claude --workflow both
```

`--platform` accepts only `claude` or `codex`.

## Host paths

| Host | Project Skills | User Skills | Rules/Hooks |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | `.claude/rules/`, `.claude/settings.local.json` |
| Codex | `.agents/skills/` | `~/.agents/skills/` | `.codex/rules/`, `.codex/hooks.json` |

Codex paths follow the [official Skills documentation](https://developers.openai.com/codex/skills).

## Use

Claude Code:

```text
/owner implement order cancellation with idempotent refunds
```

Codex:

```text
$owner implement order cancellation with idempotent refunds
```

The unified entry runs:

```bash
owner workflow resolve . --activate --json
```

It loads exactly one of `owner-loop` or `owner-pipeline` from `.owner/config.yaml`. It never switches workflows based on task size or model judgment.

## Core commands

```bash
owner status [project] --json
owner resume-probe [project] --utterance "continue yesterday's task" --json
owner doctor [project] --json

owner loop new <change> --json
owner loop status [change] --details --json
owner loop next <change> [required inputs] --json
owner loop archive <change> --preview --json

owner state init <change> full --isolation current
owner state next <change>
owner guard <change> <phase> --apply
owner handoff <change> design --write
owner archive <change> --dry-run
```

Loop portable artifacts live under `docs/owner/`; local locks, logs, receipts, and transactions live under `.owner/runtime/loop/`. Pipeline state lives in `docs/openspec/changes/<change>/.owner.yaml` by default.

## Develop

```bash
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm test:package-e2e
```

## Publish

1. Push this repository to GitHub.
2. Replace `<YOUR_GITHUB_USER>` in both READMEs.
3. Test the GitHub install command in a clean environment.
4. Test both hosts and all three workflow selections: `loop`, `pipeline`, and `both`.
5. Keep LICENSE and NOTICE intact.

## Boundaries

- A fresh Verifier reduces self-confirmation bias but is not a correctness proof.
- Owner cannot verify a requirement that was never captured in acceptance/specs.
- Unsynced code cannot be recovered from portable state alone.
- A passing Verify result does not authorize push, PR, or merge.
- Pipeline installs third-party OpenSpec and Superpowers packages.

## License

MIT. See [LICENSE](./LICENSE).
