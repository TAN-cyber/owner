# Changelog

All notable changes to `owner` are documented here.

## What's Changed [0.1.0] - 2026-08-15

### Added

- **Native workflow**: Added the self-contained Shape, Build, Verify, and Archive lifecycle with portable state, Runtime evidence, bounded repair, recovery, workspace isolation, and archive transactions.
- **Classic workflow**: Added the OpenSpec and Superpowers orchestration lifecycle with Open, Design, Build, Verify, and Archive phases, durable checkpoints, handoff hashes, TDD/review modes, and phase guards.
- **Deterministic entry**: Added the `owner` Skill and `owner workflow resolve` command to load exactly one configured workflow without model-based switching.
- **Claude Code distribution**: Added project and user-scope installation under `.claude/skills`, including Owner-managed Rules and Hooks.
- **Codex distribution**: Added project and user-scope installation under `.agents/skills`, with Owner-managed Rules and Hooks under `.codex`.
- **Lifecycle CLI**: Added `init`, `status`, `resume-probe`, `doctor`, `update`, `uninstall`, Native Runtime, Classic state/guard/handoff/archive, and package validation commands.
- **License attribution**: Preserved the required MIT copyright and license notice in LICENSE and NOTICE.

### Changed

- **Owner identity**: Standardized the package, CLI, Skills, state directories, schemas, Runtime bundles, and generated assets under the Owner identity.
- **Supported hosts**: Limited public installation and distribution targets to Claude Code and Codex; unsupported platform IDs are rejected.
- **GitHub-first install**: Documented repository distribution and made host installation an explicit `owner init` action instead of modifying a local host during download.

### Removed

- **Non-workflow products**: Removed Dashboard, Eval, Skill Creator, Publish, Bundle, Factory, CodeGraph, and their commands, dependencies, assets, tests, and stale design artifacts.
- **Unsupported hosts**: Removed installation and integration support for every host except Claude Code and Codex.
