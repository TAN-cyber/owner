---
name: owner
description: "Owner workflow entry. Use when the user invokes /owner or asks to use Owner without choosing Loop or Pipeline; resolve and load exactly one entry from project configuration."
---

# Owner Entry

`/owner` only selects an entry. It does not contain either workflow's execution method.

Once this Skill is loaded, treat the `/owner` entry as selected. Immediately perform the entry resolution below; do not re-evaluate whether the task is suitable for Owner, and do not merely explain why it will not be used.

1. Run the Owner CLI installed on PATH in the current project:

   ```text
   owner workflow resolve . --activate --json
   ```

   If project config is missing, this snapshots global defaults and creates project artifact directories. Later global changes do not rewrite it.
2. Parse the JSON. Only accept `schema: owner.workflow-resolution.v1` and a `skill` value listed below.
   If it returns `command not found`, stop and report an incomplete CLI install. If the CLI starts but exits nonzero, returns invalid JSON, or reports invalid config, stop with the original error. Do not search for Skill files, scan platform configuration directories, or invoke an internal bundle directly. Never fall back or guess.
3. Select exactly one entry based only on the returned `skill`. Immediately use the Skill tool to load that entry, and load no other entry:
    - `/owner-loop` → **Execute immediately:** Use the Skill tool to load the `owner-loop` skill. Do not skip this step.
    - `/owner-pipeline` → **Execute immediately:** Use the Skill tool to load the `owner-pipeline` skill. Do not skip this step.

   After the skill is loaded, pass the user's original request unchanged to the loaded entry Skill as its user input.

Do not switch workflows based on task size, file count, active changes, or model judgment. Loop and Pipeline changes, states, and artifacts always remain independent.
