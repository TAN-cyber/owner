# File Structure Reference

Canonical path: `owner-classic/reference/file-structure.md`

This file is the Owner project file structure reference. Consult on demand; not loaded inline with skills.

```text
<classic-open-spec-root>/              # OpenSpec — WHAT; returned by the Classic layout resolver
├── config.yaml
├── changes/
│   ├── <name>/                        # Active change
│   │   ├── .openspec.yaml
│   │   ├── .owner.yaml
│   │   ├── proposal.md                # Why + What
│   │   ├── design.md                  # High-level architecture decisions
│   │   ├── specs/<capability>/spec.md # Delta capability spec
│   │   ├── .owner/handoff/            # Script-generated phase handoff packages
│   │   └── tasks.md                   # Task checklist
│   └── archive/YYYY-MM-DD-<name>/     # Archived
└── specs/<capability>/spec.md         # Main specs (merged on archive via OpenSpec delta semantics)

<classic-superpowers-root>/            # Superpowers — HOW; returned by the Classic layout resolver
├── specs/YYYY-MM-DD-<topic>-design.md # Design doc (technical RFC; annotated on archive)
└── plans/YYYY-MM-DD-<feature>.md      # Implementation plan (file header contains change metadata)

.owner/
└── config.yaml                        # Owner project config (context_compression defaults to off; set to beta to enable)
```
