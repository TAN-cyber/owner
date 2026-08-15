# Pipeline Artifact Layout Protocol

At the start or recovery of every Pipeline phase, run this from the project root:

```bash
owner pipeline root show
```

Accept only `schema: owner.pipeline-layout.v1`. Bind the returned `openSpecRoot`, `changesRoot`, `archiveRoot`, `specsRoot`, and `superpowersRoot` as `<pipeline-open-spec-root>`, `<pipeline-changes-root>`, `<pipeline-archive-root>`, `<pipeline-specs-root>`, and `<pipeline-superpowers-root>`, respectively, then define `<pipeline-change-dir>` as `<pipeline-changes-root>/<name>`. These logical roots are the source of truth for this turn. Resolve them again after recovery or context compaction.

## Command rules

- This and every other Owner-owned Pipeline Skill must call the official OpenSpec CLI directly through:

  ```bash
  owner pipeline openspec -- <args...>
  ```

- The adapter runs the official CLI from the configured OpenSpec base and preserves stdout, stderr, and the exit code. Do not register or query an OpenSpec store for a root inside the same repository.
- Run `openspec` directly only when the user explicitly operates from the resolved OpenSpec base.

## Path rules

- Express change, tasks, delta spec, handoff, and archive paths with the `<pipeline-*>` logical roots bound above; for example, use `<pipeline-change-dir>/tasks.md`. Do not wrap one physical layout in a logical-path convention and keep using it as filesystem guidance.
- Resolve Superpowers files through `<pipeline-superpowers-root>/...`; do not derive them from the OpenSpec root or current cwd.
- `owner state`, `owner guard`, `owner handoff`, and `owner archive` resolve the layout internally. Never persist a physical root in `.owner/current-change.json`.
- If root show or a write command reports conflicting legacy/docs roots, invalid config, or an incomplete migration, stop. Use `owner doctor` for read-only inspection; do not scan both roots, guess change ownership, or dual-write.

## New, existing, and migrated projects

- New Pipeline projects default to `docs/openspec/`.
- A missing `pipeline.artifact_layout` defaults to `docs/openspec/`. When `owner update` detects existing root-level `openspec/` artifacts, it explicitly backfills `legacy` without moving them.
- Normal init/update never moves existing artifacts. Run `owner pipeline root move docs --dry-run` to inspect the current state; after confirmation, run `owner pipeline root move docs --apply` to migrate. The Runtime manages migration identity and locked revalidation internally.
- Migration moves the complete legacy-layout tree as-is, including active, unmanaged, and incompletely archived changes; change state does not block a root move.
