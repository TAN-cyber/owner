# Contributing to Owner

Languages: [English](CONTRIBUTING.md) | [中文](CONTRIBUTING-zh.md)

Thank you for helping improve Owner. This guide explains how to set up the
project, prepare a change, keep branches healthy, submit a pull request, and
update project-specific assets such as skills and workflow runtimes.

Deeper project conventions (Chinese terminology, changelog authoring, bilingual
skill sync, restraint on README updates, etc.) live in `CLAUDE.md`. This guide
covers only the contribution flow itself and does not repeat those rules.

## Before You Start

- First-time contributors can look for issues labeled `good first issue`.
- For bug fixes, first check whether an issue or recent PR already covers the
  same problem.
- For larger behavior changes, open an issue or draft PR early so the direction
  can be discussed before too much code is written.
- Keep each contribution focused on one purpose. Split unrelated changes into
  separate PRs.
- Include tests or explain why a change does not need tests.
- Update documentation and `CHANGELOG.md` when behavior, commands, workflows, or
  user-facing text changes.
- A PR version may only be ahead of `master` by exactly one version. For
  example, if `master` is `0.3.0`, the PR version must be `0.3.1`.

## Standard Contribution Workflow

- Leave a comment under the issue you want to claim, to avoid duplicate work.
- Create a task branch from the latest `master`, named after the feature or fix
  area, for example `fix/dev-resync-docs` or `docs/contributing-guide`.
- Implement the change locally, add tests, and run targeted checks.
- Before PR review, run the full verification command:
  `pnpm build && pnpm lint && pnpm format:check && pnpm test`, unless the change
  is documentation-only.
- Open a PR against `master` and follow the template to describe what changed,
  why it changed, and how it was verified.
- After the PR is submitted, three AI reviewers will leave feedback. Their
  suggestions are not always correct — you need to identify which comments are
  actionable and which are AI misjudgments, and address everything genuinely
  related to your PR.
- Once you fix the AI review comments, just push your changes; the PR updates
  automatically. You must reply to every AI comment and click
  `Resolve conversation` on the ones you consider resolved.
- After everything is resolved, wait for the human maintainer's review
  feedback.

## Issues You Can Claim

- Issues labeled `good first issue`.
- Issues labeled `task`.
- Issues labeled `bug`.
- Before claiming, confirm the issue has not already been claimed by or
  assigned to someone else, to avoid duplicate work.

## Development Setup

```bash
git clone https://github.com/TAN-cyber/owner.git
cd owner
pnpm install
pnpm build
```

- Node.js `>=22`. The pnpm version is pinned in `package.json`'s `packageManager`
  field (currently `pnpm@10.18.3`).
- If dependency installation or build behavior differs locally, mention it in
  the PR.

## Commands

| Command                       | Purpose                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Watch mode (TypeScript)                                                               |
| `pnpm build`                  | Full build (Pipeline, Loop, and entry runtimes)                                       |
| `pnpm build:pipeline-runtime` | Build only the Pipeline runtime (`scripts/build/build-pipeline-runtime.mjs`)          |
| `pnpm build:loop-runtime`     | Build only the Loop runtime (`scripts/build/build-loop-runtime.mjs`)                  |
| `pnpm build:entry-runtime`    | Build only the shared entry and Hook Router (`scripts/build/build-entry-runtime.mjs`) |
| `pnpm test`                   | Run unit tests (Vitest)                                                               |
| `pnpm test:coverage`          | Run tests with coverage                                                               |
| `pnpm test:script-smoke`      | Run the Pipeline launcher smoke suite; CI entry point                                 |
| `pnpm test:watch`             | Vitest watch mode                                                                     |
| `pnpm lint`                   | ESLint + architecture linter                                                          |
| `pnpm lint:architecture`      | Repository layering linter (`scripts/lint/architecture.mjs`)                          |
| `pnpm lint:fix`               | ESLint auto-fix                                                                       |
| `pnpm format`                 | Prettier formatting for `app/`, `domains/`, `platform/`                               |
| `pnpm format:check`           | Prettier check (CI-enforced)                                                          |

For workflow runtime work, first check freshness for the affected owner. Pipeline
launchers also have a focused smoke suite:

```bash
node scripts/build/build-pipeline-runtime.mjs --check
node scripts/build/build-loop-runtime.mjs --check
node scripts/build/build-entry-runtime.mjs --check
npx vitest run test/domains/owner-pipeline/owner-scripts.test.ts
```

Before opening or updating a PR, run the full verification command unless the
change is documentation-only:

```bash
pnpm build && pnpm lint && pnpm format:check && pnpm test
```

## Branching Model

- `master` is the canonical development and release base.
- Create task branches from the latest `master`.
- Open PRs against `master`.
- Merge PRs with **Squash and merge**.
- Treat squashed PR branches as disposable: delete them after merge, or
  recreate/reset them from `master` before reuse.

Squash merge creates a new commit on `master`. If the source branch still keeps
the original commits, Git cannot always recognize that both histories contain
equivalent changes. Because of that, do not keep merging `master` back into a
branch that has already been squashed.

## Preparing a Change

```bash
git fetch origin
git switch master
git pull --ff-only origin master
git switch -c <type>/<short-topic>
```

Use a short branch name that describes the change, for example
`fix/dev-resync-docs` or `docs/contributing-guide`.

While working:

- Keep commits small enough to review.
- Prefer adding tests before or with the implementation.
- Run targeted tests during development.
- Re-run formatting before the final diff.
- Avoid broad rewrites, formatting sweeps, or unrelated metadata churn.

## Keeping a PR Current

If a PR branch falls behind `master`, prefer rebasing your task branch onto the
latest `master`:

```bash
git fetch origin
git switch <your-branch>
git rebase origin/master
# resolve conflicts, then run the relevant checks
git push --force-with-lease
```

Use `--force-with-lease` after a rebase because it protects remote work that you
do not have locally. Avoid plain `--force`.

If the branch has become tangled with unrelated commits, create a clean branch
from `origin/master` and cherry-pick only the commits that belong to the PR:

```bash
git fetch origin
git switch -c <topic>-take-2 origin/master
git cherry-pick <commit-1> <commit-2>
# run checks
git push --force-with-lease origin <topic>-take-2:<original-branch>
```

This keeps the PR reviewable and prevents accidental merges of unrelated work.

## Shared `dev` Branch

If you keep a shared `dev` branch, use it only as a temporary working branch.
After a PR from `dev` is squashed into `master`, do not merge `master` back into
`dev`. Reset `dev` to `origin/master` after confirming there is no unsquashed
work that still needs to be preserved:

```bash
git fetch origin
git switch dev
git status --short
git branch backup/dev-before-sync-YYYYMMDD
git reset --hard origin/master
git push --force-with-lease origin dev
```

If `dev` contains work that has not been merged to `master`, move that work to a
new branch from `origin/master` before resetting `dev`.

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <description>
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`

Examples:

```text
feat(loop): add archive preview output
fix(pipeline): preserve checkpoint recovery state
docs: update contributor commit rules
```

## Local Pre-commit Hook

The repository ships a Git pre-commit hook (`.husky/pre-commit` + `lint-staged`)
that runs `prettier --write` on every `git commit` against staged source files
under `app/`, `domains/`, and `platform/`. The scope matches CI `format:check`,
is editor-independent, and applies to every contributor.

- The hook is installed by `husky` during `pnpm install`.
- On Windows with `core.autocrlf=true`, untouched legacy files may be falsely
  flagged by `prettier --check` due to CRLF. The hook only processes staged
  files; legacy files are auto-converted to LF the next time they are edited.
- You should still run `pnpm lint`, `pnpm build`, and `pnpm test` manually
  before committing — CI enforces all of them.

## PR Process

1. Update `master` and create a feature branch from it.
2. Implement a focused change with tests.
3. Run targeted checks while developing.
4. Run `pnpm build && pnpm lint && pnpm format:check && pnpm test` before PR
   review, unless the change is documentation-only.
5. Open a PR against `master`.
6. Describe what changed, why it changed, and how it was verified.
7. Respond to review feedback with follow-up commits.
8. Use **Squash and merge** when the PR is approved.
9. Delete or recreate the source branch after merge; do not keep merging
   `master` back into a squashed branch.

For documentation-only changes, run at least the relevant formatter check. Root
`README.md` and `README-zh.md` are listed in `.prettierignore` and are not
checked by Prettier, for example:

```bash
npx prettier --check CONTRIBUTING.md CONTRIBUTING-zh.md
```

## Project Structure

Source code is layered by responsibility, with each layer having a clear scope:

```text
app/                 # CLI entry and command orchestration. Composes domain/platform capabilities only; holds no domain rules.
├── cli/             # Commander registration
└── commands/        # owner init / status / workflow / resume-probe / doctor / update / uninstall / loop / pipeline

domains/             # Business domain modules
├── engine/          # Shared execution state, loops, guardrails, and checks
├── integrations/    # OpenSpec and Superpowers integrations
├── owner-pipeline/   # Pipeline workflow (state / guard / handoff / archive / intent / hook-guard)
├── owner-entry/     # Shared Loop/Pipeline entry, selection, and Hook Router
├── owner-loop/    # Loop workflow (change / state / evidence / archive / guard)
├── skill/           # Owner Skill installation, updates, and removal
└── workflow-contract/ # Cross-workflow contracts

platform/            # Platform adaptation; domain code does not leak platform differences
├── fs/              # Filesystem utilities
├── install/         # Platform definitions, detection, install paths
├── paths/           # Repository layout resolution
├── process/         # Subprocesses, error handling, shell quoting
└── version/         # Version comparison

scripts/             # Repository automation (build / release / lint / install)
├── build/           # Pipeline, Loop, and entry runtime builders
├── install/         # postinstall.js
├── lib/             # Cross-script utilities
├── lint/            # architecture.mjs, gitignore-top-level.mjs
└── release/         # prepare.js, prepublish-check.js

assets/              # Release assets: built-in skill content and install manifest
├── skills/          # English skills
├── skills-zh/       # Chinese skills
└── manifest.json    # Install entry point

docs/                # Architecture, operations, and design docs (docs/superpowers/ is written by the workflow)
```

`bin/owner.js` is the npm `bin` entry; `build.js` is the top-level build
script; `vitest.config.ts` / `eslint.config.js` / `tsconfig.json` are tooling
configurations.

## Architecture Linter

`pnpm lint:architecture` (`scripts/lint/architecture.mjs`) verifies:

- The top-level directory whitelist
  (`config/repository-layout.json`'s `allowedTopLevelEntries`).
- Active source roots are restricted to `app` / `domains` / `platform`
  (`sourceRoots`).
- Sub-modules of each layer
  (`appModules` / `domainModules` / `platformModules` / `scriptModules`).
- Pipeline, Loop, and entry runtime entry/output consistency.
- Built-in skill roots and the install manifest are consistent.
- Test ownership (see the next section).
- Migration-legacy directories (e.g. `src/`, `test/ts/`) are not reintroduced.

If you genuinely need to add a top-level directory, source module, test root,
or exception, **you must update `config/repository-layout.json`, the
architecture linter rules, and the relevant sections of this guide before
opening the PR**.

## Test Directory Layout

Test directories strictly follow the ownership of the code under test:

| Test directory           | Coverage                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `test/app/`              | CLI and commands under `app/`                                                                              |
| `test/domains/<domain>/` | The matching `domains/<domain>/` (each domain has a same-named subdirectory)                               |
| `test/platform/`         | The `platform/` adaptation layer                                                                           |
| `test/scripts/`          | The `scripts/` automation scripts                                                                          |
| `test/repository/`       | Cross-layer constraints: README, CI workflows, repository layout, package scripts, workflow runtime assets |
| `test/fixtures/`         | Test data                                                                                                  |
| `test/helpers/`          | Test utilities (`owner-test-utils.ts`, `ensure-cli-built.ts`, `workflow-plan.ts`)                          |

Do not add horizontal buckets like `test/ts/`; legacy files should be migrated
to the directories above. The CI smoke entry point is
`pnpm test:script-smoke`; GitHub Actions and local runs share the same Pipeline
launcher smoke suite.

## Host Boundary

Owner supports only Claude Code and Codex. Keep platform definitions, prompts,
OpenSpec tool IDs, Superpowers agent mappings, installation paths, and tests
limited to these two hosts unless the product scope is explicitly changed.

## Adding or Updating a Skill

1. Write or update the Chinese version first under `assets/skills-zh/`.
2. Get the wording and behavior confirmed, then sync the English version under
   `assets/skills/`. The two versions must be behaviorally equivalent.
3. Add new skills to `assets/manifest.json`.
4. Add tests for generated assets or installer behavior when applicable
   (`test/domains/skill/`, `test/repository/pipeline-runtime-assets.test.ts`).
5. When changing skill boilerplate, sync every copy across all `SKILL.md` and
   `reference/*` files.
6. **Never directly modify the original Superpowers or OpenSpec skills.**

Skill design guidance:

- **Decision Core first**: Agent-facing instructions go at the top, including
  phase detection, dispatch logic, and error handling.
- **Reference Appendix**: Field reference, script locations, and best practices
  go at the bottom.
- Keep Chinese and English versions behaviorally equivalent, even when wording
  differs naturally. Chinese terminology follows the translation rules in
  `CLAUDE.md` (do not translate `gate` as "门").

## Workflow Runtimes and Hook Routing

Workflow scripts are **generated Node.js bundles** (`.mjs`). They
depend only on Node.js and **never on Bash / Git Bash / WSL**, so behavior is
identical on macOS, Linux, and Windows.

- Pipeline logic and per-command entries live in `domains/owner-pipeline/`;
  `pnpm build:pipeline-runtime` generates the aggregate CLI runtime and one
  self-contained bundle per command in `assets/skills/owner/scripts/`.
- Loop logic lives in `domains/owner-loop/`; `pnpm build:loop-runtime`
  generates the aggregate CLI runtime and one self-contained bundle per Loop
  command. The Loop core workflow and Guard must not depend on external
  Skills.
- Shared entry resolution, selection, and Hook routing live in
  `domains/owner-entry/`; `pnpm build:entry-runtime` generates
  `owner-entry-runtime.mjs` and `owner-hook-router.mjs`.
- Each platform installs one `owner-workflow-guard` Rule. Platforms with Hook
  support install only `owner-hook-router.mjs`. The Router uses
  `.owner/current-change.json` to invoke exactly one Loop or Pipeline Guard per
  write. Their phases, directories, schemas, and Guard logic remain separate.
- `owner-hook-guard.mjs` and `owner-loop-hook-guard.mjs` are self-contained
  workflow Guard command bundles; neither is installed directly as a platform
  Hook.
- Cross-platform concerns are handled by Node: hashing via `node:crypto`, YAML
  via the `yaml` package, subprocesses via `child_process`
  (build/validate commands go through `spawnSync(cmd, { shell: true })`). There
  are no `sed -i` / `sha256sum` vs `shasum` / `pipefail` portability hazards.
- `owner-env.mjs` prints its own directory so Skill instructions can resolve
  sibling bundle paths once. Instructions record literal absolute paths in task
  context and must not rely on shell-local variables persisting across tool
  calls.
- When adding or renaming an entry or generated output, sync
  `assets/manifest.json`, the matching runtime mapping in
  `config/repository-layout.json`, and the corresponding
  `test/repository/*-runtime-assets.test.ts`. Pipeline command bundles also require an
  update to the fixture list in
  `test/domains/owner-pipeline/owner-scripts.test.ts`.

Runtime dispatch:

```text
owner-runtime.mjs + owner-<command>.mjs               <- domains/owner-pipeline/*
owner-loop-runtime.mjs + owner-loop-<command>.mjs <- domains/owner-loop/*
owner-entry-runtime.mjs                                <- domains/owner-entry/*
owner-hook-router.mjs                                  <- only installed Hook entry -> one Guard selected by current ownership
```

## `.owner.yaml` State Changes

When changing fields in a `.owner.yaml` state file, update all three places (all
in TypeScript):

1. `domains/owner-pipeline/pipeline-state-command.ts` for the `set` whitelist and
   enum validation (`SETTABLE_FIELDS` / `MACHINE_OWNED_FIELDS`).
2. `domains/owner-pipeline/pipeline-validate-command.ts` for schema validation
   and the known field set.
3. `test/domains/owner-pipeline/owner-scripts.test.ts` for YAML examples and
   assertions.

Then run `pnpm build` to regenerate `owner-runtime.mjs`, otherwise the freshness
check in `pipeline-runtime.test.ts` will fail.

## Documentation and Bilingual Conventions

Detailed rules live in `CLAUDE.md`. Quick reference:

- **Bilingual order**: Write the Chinese version of skills / docs first
  (`assets/skills-zh/`, `README-zh.md`, `CONTRIBUTING-zh.md`,
  `docs/operations/*-ZH.md`), then sync the English version after user
  confirmation. For skill content changes, do not write the changelog entry
  until Chinese and English are fully in sync.
- **README restraint**: After a feature update, do not pile every highlight
  into the README. Necessary features should be referenced via `docs/`.
- **Chinese terminology**: Do not translate `gate` as "门" (e.g. "压缩门" /
  "调试门" reads unnaturally). Translate by context as "协议" (protocol),
  "阶段" (phase), "检查" (check), or "阻塞点" (blocker). Modifying
  `proactive` / `active` translates as "主动式".
- **Skill trigger phrasing**: Chinese uses the unified
  `**立即执行：** 使用 Skill 工具加载 <skill-name> 技能。禁止跳过此步骤。`
  and English uses the unified
  `**Immediately execute:** Use the Skill tool to load the <skill-name> skill. Skipping this step is prohibited.`.
- **Commit / GitHub conventions**: Do not comment on or open PRs on GitHub
  without explicit approval; do not append a `Co-Authored-By` line to commit
  messages.

## Changelog

`CHANGELOG.md` is written in English and records **user-visible** behavior
changes. See `CLAUDE.md` for the full categorization and the
"release-perspective check" rules. Quick reference:

- The version number must match `package.json`. New version entries go at the
  top, and a PR may only be one version ahead of `master`.
- If the current branch already has a version entry ahead of `master`, append
  to that same entry instead of adding a new running-tally version.
- Group order: `Added → Changed → Fixed → Tests → Removed → Security`. Each
  entry starts with `- **Bold keyword**: `.
- Describe behavior changes and rationale, not implementation trivia.
- Before writing, run `git log <previous-tag>..HEAD --oneline` to see the real
  diff; only write "what a user upgrading from the previous version would
  notice".
- Do not include branch-internal review follow-ups, doc syncs, test refactors,
  or internal fixes in the changelog.
- For skill content changes, the changelog entry must wait until Chinese and
  English are fully in sync.

Template:

```markdown
## What's Changed [x.y.z] - YYYY-MM-DD

### Added

- **Feature name**: Describe what changed and why.

### Changed

### Fixed

### Tests

### Removed

### Security
```

`### Tests` is only used when the testing/evaluation capability itself is a
user-runnable release feature; ordinary regression tests, coverage backfill,
and test file migrations are not recorded in the changelog.

## Release (Maintainers)

1. Push the release commit to GitHub and confirm the working tree is clean.
2. Run the release checks:

   ```bash
   node bin/owner.js --version
   node bin/owner.js init --help
   pnpm check:generated
   npm run prepublishOnly
   npm pack --dry-run
   ```

3. Run `npm login` with an account that owns the `redv` scope.
4. Publish with `npm publish --access public` and enter the current two-factor authentication code when npm prompts. Do not put the code in shell history.
5. For CI or another non-interactive publisher, use a Granular Access Token with read/write package access for the `redv` scope and 2FA bypass enabled. Store it only in a secret manager or CI secret; never commit it or a credential-bearing `.npmrc`.
6. Verify the registry and a clean installation:

   ```bash
   npm view @redv/owner version
   npm install @redv/owner
   ```

When a maintainer must configure a Granular Access Token locally, read it without echoing it or recording it in shell history, then remove the npm configuration after publishing:

```bash
printf 'Granular npm token: '
read -s NPM_TOKEN
printf '\n'
export NPM_TOKEN
npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
npm publish --access public
npm config delete //registry.npmjs.org/:_authToken
unset NPM_TOKEN
```

## Security

- Scan for API keys, secrets, tokens, and private keys before publishing.
- Keep `.npmignore` aligned so source-only and local configuration files are not
  published to npm.
- Keep `.gitignore` coverage for secrets, credentials, and IDE-specific files.
- Validate user-provided change names against path traversal before using them
  in filesystem paths.
- In symlink install mode, skill installation must not replace a `skills/`
  directory that contains files outside the managed manifest (see issue #159 in
  the `0.4.0-beta.2` entry of `CHANGELOG.md`).
