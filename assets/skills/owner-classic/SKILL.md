---
name: owner-classic
description: "Owner Classic workflow (OpenSpec + Superpowers). Use when the user invokes /owner-classic, asks to start or resume it, or resume-probe returns an unambiguous active Classic change."
---

# Owner Classic — OpenSpec + Superpowers Dual-Star Development Workflow

Before starting or recovering, read and follow `owner-classic/reference/classic-layout.md`. Every OpenSpec CLI call in this file must use the adapter, and every file path must use the `<classic-*>` logical roots bound by that protocol.

OpenSpec and Superpowers orbit the same goal like a binary star system.

```
OpenSpec handles WHAT  — outline, proposal, spec lifecycle, archive
Superpowers handles HOW — technical design, planning, execution, closing
```

**Core principle: brainstorming cannot be skipped. Every change must undergo deep design (except hotfix and tweak presets).**

---

## Decision Core

Agents need only read this section for decision-making. Refer to the Reference Appendix as needed.

### Output Language Rule

Use the configured Owner artifact language as the output language for every OpenSpec and Superpowers artifact. The configured value is a normalized language id, `en` or `zh-CN`. For an existing change, read `language` from `<classic-change-dir>/.owner.yaml` using `owner state get <name> language`. Before `.owner.yaml` exists, read `classic.language` from project `.owner/config.yaml`, then fall back to global `~/.owner/config.yaml`; if neither exists, fall back to the current user request language. Include the resolved language explicitly in every prompt or ARGUMENTS passed to external OpenSpec/Superpowers skills.

### Automatic Phase Detection

**Step 0: Active Change Discovery and Intent Resolution**

1. First follow `owner-classic/reference/scripts.md` and run the public `owner` CLI command directly.
2. Run `owner classic openspec -- list --json` to collect active changes.
3. Fill a `OwnerIntentFrame` from the user request, active change list, and necessary repository state.
4. Prefer `owner classic intent route --stdin` to pass the frame JSON and get the runtime-normalized route. `OwnerIntentFrame + runtime scorer` is the source of truth; this prose is only for intent recognition slot extraction.
5. Handle the runtime route:
   - `hotfix` → invoke `/owner-hotfix`
   - `tweak` → invoke `/owner-tweak`
   - `full` → follow the active-change table to invoke `/owner-open` or ask for confirmation
   - `resume` → continue to Step 1 and read the selected change `.owner.yaml`
   - `ask_user` → pause through `owner-classic/reference/decision-point.md` and wait for the user's choice
   - `out_of_scope` → explain that the input is not a Owner workflow start/resume request and do not initialize a change

After the runtime route, Ambient Resume, or user choice resolves one explicit change, bind the current execution context before entering its phase Skill:

```bash
owner classic workspace resolve <change-name> --json
# enter the returned projectRoot; state select writes the selection there
owner state select <change-name>
```

Workspace decisions happen in `/owner-open` and follow `owner-classic/reference/workspace.md`: explicit parallel, simultaneous, or multi-session intent prepares a Worktree before binding; when isolation is unspecified, present `current`, `branch`, and `worktree` as a single-choice decision when needed, with recommendations as explanation only. Preparation and resume scan registered Worktrees and prefer the one whose branch matches. Ask for rebind when the branch was renamed, taken over, or its ownership cannot be confirmed.

When multiple active changes exist and the user has not selected one, do not bind early; keep the existing `ask_user` decision point.

### Owner Ambient Resume

When the user did not explicitly invoke `/owner-classic`, but this repository may already have an active Owner change, run the read-only probe before starting work that may need code changes or investigation:

```bash
owner resume-probe . --stdin --json
```

The probe only reads repository state. Follow the returned action:

- `auto_resume`: print one line, `[OWNER] Detected active change <name>; resuming via <nextCommand>.`, then enter `nextCommand`.
- `ask_user`: ask one short question and wait.
- `out_of_scope` or `none`: do not enter the Owner workflow.

Never attach unrelated work to an active Owner change only because `.owner.yaml` exists.

**Minimal OwnerIntentFrame Skeleton**:

```json
{
  "schema_version": "owner.intent.v1",
  "utterance": "<user request>",
  "intent": { "name": "start_change", "confidence": 0.8 },
  "slots": {
    "requested_action": "start",
    "workflow_candidate": "full",
    "user_explicit_workflow": null,
    "change_id": null,
    "existing_behavior": null,
    "new_capability": null,
    "public_api_change": null,
    "schema_change": null,
    "cross_module_change": null
  },
  "context": {
    "active_changes_count": 0,
    "active_change_names": []
  },
  "evidence": [],
  "proposed_route": {
    "name": "ask_user",
    "confidence": 0.5
  }
}
```

**Intent Recognition Slot Extraction**:
See `owner-classic/reference/intent-frame.md` for complete field meanings; normal routing only needs the minimal skeleton above.

- `fix_bug` + `existing_behavior: true` + no new capability/public API/schema/cross-module signal → prefer `hotfix`
- User explicitly describes a lightweight/medium change that can fit in a single OpenSpec change, should be executed through OpenSpec apply, and does not need full `/owner-classic` deep design/plan → prefer `tweak`
- Copy, config, docs, prompt, or a lightweight/medium single OpenSpec change → prefer `tweak`
- New capability, public API, schema change, cross-module coordination, or architecture work → prefer `full`
- Multiple active changes without an explicit change → `ask_user`
- Low confidence, missing key evidence, or explicit workflow conflicting with risk signals → `ask_user`

| Active changes | User input | Behavior |
|----------------|------------|----------|
| None | `full` route | → Invoke `/owner-open` |
| Exactly 1 | `/owner-classic <description>` | → **Ask**: continue this change or create a new change |
| Multiple | `/owner-classic <description>` | → **Ask**: continue existing or create new; if continuing, list changes for selection |
| Exactly 1 | `/owner-classic` with no description | → Auto-select, enter Step 1 |
| Multiple | `/owner-classic` with no description | → List changes for user selection |

<IMPORTANT>
When the user chooses "create a new change", **must invoke `/owner-open`**. Do not call `/opsx:new` directly.
`/owner-open` performs dual initialization: OpenSpec artifacts (created by internal `/opsx:new`) plus `.owner.yaml` state file.
Calling `/opsx:new` directly leaves `.owner.yaml` missing and breaks later phase detection.
</IMPORTANT>

**Step 1: Read `.owner.yaml` state metadata**

Prefer reading `<classic-change-dir>/.owner.yaml`. If not available, fall back to `owner classic openspec -- status --change "<name>" --json`, `<classic-change-dir>/tasks.md`, and `<classic-superpowers-root>/` file checks.

**Resume rules**:
- On every context resume, rerun Step 0 and Step 1; do not trust conversation history for phase detection
- If there is an active change and the worktree has uncommitted changes, handle them through `owner-classic/reference/dirty-worktree.md`. That protocol defines checks, attribution, and prohibitions; this file does not repeat them
- If `phase: build`, first check `build_pause`, `plan`, `isolation`, `build_mode`, `tdd_mode`, and `review_mode` (see details below):
  - If `build_pause: plan-ready` but `isolation`, `build_mode`, `tdd_mode`, and `review_mode` are all already set, treat as stale pause: first output `[OWNER] Detected stale pause (build_pause=plan-ready but isolation/build_mode/tdd_mode/review_mode are set), auto-clearing and continuing`, then run `owner state set <name> build_pause null`, then read the next unchecked task from tasks.md and resume execution per `build_mode`
  - If `build_pause: plan-ready` and the plan file exists, but `isolation`, `build_mode`, `tdd_mode`, or `review_mode` is not yet set, return to the `/owner-build` plan-ready resume point, prompt the user to complete/confirm workspace isolation, execution method, TDD mode, and code review mode, and do not regenerate the plan
  - If `build_pause: plan-ready` but the plan file is missing, return to `/owner-build` to handle corrupted state or regenerate the plan
  - If an older change has no `isolation`, return to `/owner-open` for workspace resolve/prepare; do not make the first workspace decision in Build
  - If `build_mode`, `tdd_mode`, or `review_mode` is unset, return to the corresponding `/owner-build` step to supplement before executing
  - If all are set, read the next unchecked task from tasks.md and continue:
    - If `build_mode: subagent-driven-development`, do not execute tasks directly in the main window; return to `/owner-build`'s background subagent dispatch rules, main window only coordinates
    - Other execution modes follow `/owner-build`'s corresponding rules
- If `verify_result: fail`, read `verify_failures`. At 3 or fewer failures, invoke `/owner-build` directly to continue the recorded repair loop without re-asking. Above the automatic limit, return to `/owner-verify` for the exception decision. User input is required only to accept a WARNING/SUGGESTION deviation or choose a strategy after the retry limit
- If `phase: open` but OpenSpec `applyRequires` is complete, run `owner guard <change-name> open --apply` to repair state, then continue detection
- If `phase: archive`, only invoke `/owner-archive`; confirm first, archive, commit exact archive paths, then handle the branch and run the archive guard

**Step 2: Phase Determination** (check in order, first match wins)

1. `archived: true` or change moved to archive → Workflow complete
2. `verify_result: pass` and `archived` is not `true` → Invoke `/owner-archive` (first perform final archive confirmation)
3. `verify_result: fail` → Invoke `/owner-build` automatically to continue repair. If `verify_failures` exceeds the automatic limit, enter `/owner-verify`'s retry-limit strategy decision
4. `phase: verify` or tasks.md all checked → Invoke `/owner-verify`
5. `phase: build` or has Design Doc but plan/execution incomplete → Route by workflow: `hotfix` → `/owner-hotfix`, `tweak` → `/owner-tweak`, `full` → `/owner-build`
6. `phase: design` or has change but no Design Doc → Invoke `/owner-design`
7. `phase: open` or active change exists but `.owner.yaml` is missing → Invoke `/owner-open`
8. No active change → Invoke `/owner-open`

If metadata conflicts with file state, use verifiable file state as source of truth and correct `.owner.yaml` before continuing.

### Preset Upgrade Assessment

hotfix/tweak scope assessment uses a three-layer division of labor, avoiding "using pure file count as a hard upgrade condition" that wrongly blocks normal small changes:

1. **Qualitative-change signals** (agent semantic recognition; hitting any one pauses and delegates a two-choice decision to the user): cross-module coordinated change, new capability needed, database schema change, introduces new public API, hits deep architecture issues (each preset reuses this core signal set and may add its own context-specific signal, such as tweak's "needing to split into multiple OpenSpec changes")
2. **File-count tripwire** (user decides; not an automatic upgrade): when changed files exceed a hint threshold, pause and let the user decide whether to continue the preset or upgrade to full; do not auto-kick
3. **Verification weight** (scale script decides): `owner state scale` only decides `verify_mode` (verification weight); it does not block the flow or trigger an upgrade

**Upgrade decision point (user chooses one of two)**:
- Continue the preset lightweight flow (user confirms scope is manageable)
- Upgrade to full `/owner-classic` (use `owner state transition <name> preset-escalate` to legally rewind to design and clear preset-only build settings; after the Design Doc, choose the full workflow configuration again in one joint decision)

See the "Upgrade Assessment" section of each `owner-hotfix` / `owner-tweak` for detailed rules.

### Error Handling Quick Reference

| Scenario | Handling |
|----------|----------|
| `owner classic openspec -- list --json` fails | Check whether OpenSpec is installed; if the artifact root is missing or damaged, prompt the user to run `owner update --scope project` or rerun `owner init --scope project` |
| Sub-skill unavailable | Stop workflow, prompt to install or enable the corresponding skill |
| `.owner.yaml` missing | Enter the relevant preset's `/owner-open` initialization, then run `owner state select`; never skip initialization |
| `.owner.yaml` malformed | Stop and report the parse error; repair from version control, backup, or verifiable artifacts, never overwrite it with `owner state set` |
| Build/test fails | Return to build phase for fixes, do not enter verify |
| Incomplete change directory structure | Fill missing files according to `owner-open` artifact requirements |

### Phase Transitions

<IMPORTANT>
A single `/owner-classic` invocation starts from the detected phase and advances to the next phase when exit conditions are met.

Flow chain: open → design → build → verify → archive

**Continuous execution requirement**: starting from the detected phase, the agent automatically continues through all later phases. But **auto-advancing only applies at transition points without user decisions**. When encountering user decision points, pause, present clear options, and wait for the user's explicit response. Must not use recommendation rules, defaults, or historical preferences to substitute for user confirmation, and must not just output a text prompt and then continue executing.

**Distinguish phase advancement vs automatic handoff**: each sub-skill runs phase guard `--apply` before exit to advance the `.owner.yaml` `phase` field. This step **always happens** and is not controlled by `auto_transition`. After that, the sub-skill runs `owner state next <name>` to resolve the next action: when `auto_transition` is not `false`, output is `NEXT: auto` (auto-invoke next skill); when `auto_transition` is `false`, output is `NEXT: manual` (do not invoke next skill; return control with `HINT`). `NEXT: manual` is not a user decision point and must not ask whether to continue. Therefore `auto_transition` **only controls next skill invocation, not phase advancement**. Regardless of `auto_transition`, genuine user decision points below remain blocking.

**Decision points are blocking points**: whenever reaching any of the following nodes, the current `/owner-classic` invocation must stop, and follow the `owner-classic/reference/decision-point.md` protocol to obtain the user's explicit choice. Only after the user explicitly chooses can the corresponding state fields be written and operations executed, then auto-advance resumes.

Nodes requiring user participation (pause only at these nodes):
1. Workflow target selection: multiple active changes, continue an existing change versus create a new one, or choose which completed batch item starts first
2. Open-phase final proposal/design/tasks review, including the change name and scope; clear requests have no pre-artifact summary/name confirmation
3. Confirm the design approach during brainstorming
4. Open-phase workspace decision: explicit parallel intent automatically uses a Worktree; when isolation is unclear, present the legal `current`, `branch`, and `worktree` choices as one decision
5. One joint build decision: plan-ready pause, execution method, TDD mode, and code review mode
6. Verify-phase acceptance of WARNING/SUGGESTION deviations, Spec drift handling, or continue/stop after the 4th failure; the first 3 clearly repairable failures close automatically
7. Archive phase final confirmation before running the archive script
8. Choose finishing-branch handling after exact archive changes are committed
9. Encounter an upgrade-assessment signal (hotfix/tweak → user chooses one of two: continue preset / upgrade to full workflow)
10. Build phase scope expansion requiring redesign or new change split
11. Open phase large PRD split confirmation

Agents should not skip these decision points; other unambiguous phase transitions must proceed automatically, must not exit midway. At decision points, **must not skip user confirmation or choose automatically — ask clear options and wait for the user's explicit choice before continuing**.

**Red Flags** — when these thoughts appear, STOP and check:

| Agent Thought | Actual Risk |
|--------------|-------------|
| "The user would probably agree with this approach" | Cannot decide for the user — present the choice and wait for the reply |
| "This is a small change, confirmation isn't needed" | Decision points have no size exception — blocking points must wait |
| "The user chose A last time, so A again" | Historical preference cannot substitute for current confirmation |
| "I explained the plan and the user didn't object" | No objection ≠ consent — must use tool to get explicit choice |
| "The flow has reached this point, should be fine" | Verification not passed ≠ passed — check verify_result |
</IMPORTANT>

---

## Subcommand Quick Reference

| Command | Phase | Owner | Artifacts |
|---------|-------|-------|-----------|
| `/owner-open` | 1. Open | OpenSpec | proposal.md, design.md, tasks.md |
| `/owner-design` | 2. Deep Design | Superpowers | Design Doc, delta spec |
| `/owner-build` | 3. Plan and Build | Superpowers | Implementation plan, code commits |
| `/owner-verify` | 4. Verify | Both | Verification report |
| `/owner-archive` | 5. Archive and Close | OpenSpec | delta→main spec sync, design doc markup, archive commit, branch handling |
| `/owner-hotfix` | Preset path | Both | Quick fix (skip brainstorming) |
| `/owner-tweak` | Preset path | Both | OpenSpec-chained medium change (delta spec is first-class, skip brainstorming and full plan) |

```
/owner-classic
  ↓ Auto-detect
/owner-open ──→ /owner-design ──→ /owner-build ──→ /owner-verify ──→ /owner-archive
  (OpenSpec)      (Superpowers)     (Superpowers)     (Both)          (OpenSpec)

/owner-hotfix (preset, skip brainstorming)
  open ──→ build ──→ verify ──→ archive
    ↑ Upgrade-assessment signal hit → user chooses one of two (continue preset / upgrade full) → if upgrade, transition preset-escalate → supplement Design Doc → return to full workflow

/owner-tweak (lightweight preset, chains OpenSpec, delta spec is first-class)
  open ──→ build ──→ verify ──→ archive
    ↑ Upgrade-assessment signal hit → user chooses one of two (continue preset / upgrade full) → if upgrade, transition preset-escalate → supplement Design Doc → return to full workflow
```

---

## Reference Appendix

### State Machine Hard Constraints

- Before full-workflow `build → verify`, `isolation` must be `branch` or `worktree`; hotfix/tweak may truthfully use `current`
- Before `build → verify`, `build_mode` must be selected
- `build_mode: subagent-driven-development` must also have `subagent_dispatch: confirmed`
- Before full workflow leaves build phase, `tdd_mode` must be selected as `tdd` or `direct`
- Before full workflow leaves build phase, `review_mode` must be selected as `off`, `standard`, or `thorough`
- `build_mode: direct` is allowed by default only for `hotfix` / `tweak`; full workflow requires `direct_override: true`
- `build_pause` is not an execution method and must not be written to `build_mode`
- These constraints are enforced by both `owner guard <name> build --apply` and `owner state transition <name> build-complete`

### .owner.yaml Field Reference

See `owner-classic/reference/owner-yaml-fields.md` for complete field reference with examples and descriptions.

### File Structure

See `owner-classic/reference/file-structure.md` for the complete directory layout and artifact organization.

### Auto-Transition Protocol

See `owner-classic/reference/auto-transition.md` for the complete automatic handoff workflow.

### Context Recovery

See `owner-classic/reference/context-recovery.md` for structured recovery after context compression.

### Decision Point Protocol

See `owner-classic/reference/decision-point.md` for the complete user decision point protocol.

### Debug Gate Protocol

See `owner-classic/reference/debug-gate.md` for the complete debug gate protocol.

### Public CLI

Follow `owner-classic/reference/scripts.md` once per session and use only the public `owner` CLI. Do not search for or invoke internal bundles. Key entry points:

```bash
owner guard <change-name> <phase> --apply             # phase guard + state update
owner state transition <change-name> <event>          # open-complete | design-complete | build-complete | verify-pass | verify-fail
owner state next <change-name>                        # NEXT: auto|manual|done + SKILL: <skill-name>
owner archive <change-name>                           # full archive in one command
```
