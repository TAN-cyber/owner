# Owner

[中文文档](./README.md) | [Security](./.github/SECURITY.md)

[![CI](https://github.com/TAN-cyber/owner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TAN-cyber/owner/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@redv/owner.svg)](https://www.npmjs.com/package/@redv/owner)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Owner is a resumable vibe-coding workflow for Claude Code and Codex. It turns an AI coding request into a persisted, guarded lifecycle with requirement shaping, implementation, evidence-backed verification, bounded repair, recovery, and archive.

Owner provides two independent workflows:

- **Loop**: `Shape → Build ↔ Verify → Archive`. A self-contained runtime for strong autonomous models. It does not depend on OpenSpec or Superpowers.
- **Pipeline**: `Open → Design → Build → Verify → Archive`. OpenSpec owns WHAT, Superpowers owns design/TDD/debug/review methods, and Owner owns orchestration, guards, recovery, and archive.

Supported hosts:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex/skills)

## Requirements

- Node.js 22+
- npm or pnpm
- Git
- Claude Code or Codex
- Network access for Pipeline dependencies (OpenSpec and Superpowers)

## Install from npm

```bash
npm install @redv/owner
npx owner --version
```

You can also clone the [Owner GitHub repository](https://github.com/TAN-cyber/owner) and build locally:

```bash
git clone https://github.com/TAN-cyber/owner.git
cd owner
corepack enable
pnpm install
pnpm build
npm link
```

Installing the CLI does not modify a host configuration. Owner writes Skills, Rules, and Hooks only after the user explicitly runs `npx owner init`.

## Initialize

Codex with both workflows:

```bash
npx owner init /path/to/project \
  --scope project \
  --platform codex \
  --workflow both
```

Claude Code with Loop:

```bash
npx owner init /path/to/project \
  --scope project \
  --platform claude \
  --workflow loop
```

Global installation is explicit:

```bash
npx owner init --scope global --platform codex --workflow both
npx owner init --scope global --platform claude --workflow both
```

`--platform` accepts only `claude` or `codex`.

## Host paths

| Host        | Project Skills    | User Skills         | Rules/Hooks                                     |
| ----------- | ----------------- | ------------------- | ----------------------------------------------- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | `.claude/rules/`, `.claude/settings.local.json` |
| Codex       | `.agents/skills/` | `~/.agents/skills/` | `.codex/rules/`, `.codex/hooks.json`            |

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
npx owner workflow resolve . --activate --json
```

It loads exactly one of `owner-loop` or `owner-pipeline` from `.owner/config.yaml`. It never switches workflows based on task size or model judgment.

## Core commands

```bash
npx owner status [project] --json
npx owner resume-probe [project] --utterance "continue yesterday's task" --json
npx owner doctor [project] --json

npx owner loop new <change> --json
npx owner loop status [change] --details --json
npx owner loop next <change> [required inputs] --json
npx owner loop archive <change> --preview --json

npx owner state init <change> full --isolation current
npx owner state next <change>
npx owner guard <change> <phase> --apply
npx owner handoff <change> design --write
npx owner archive <change> --dry-run
```

Loop portable artifacts live under `docs/owner/`; local locks, logs, receipts, and transactions live under `.owner/runtime/loop/`. Pipeline state lives in `docs/openspec/changes/<change>/.owner.yaml` by default.

## Boundaries

- A fresh Verifier reduces self-confirmation bias but is not a correctness proof.
- Owner cannot verify a requirement that was never captured in acceptance/specs.
- Unsynced code cannot be recovered from portable state alone.
- A passing Verify result does not authorize push, PR, or merge.
- Pipeline installs third-party OpenSpec and Superpowers packages.

## License

MIT. See [LICENSE](./LICENSE).
