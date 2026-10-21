---
type: rule
domain: roblox-ui
status: provisional
basis: stated
topic: code
always: false
applies_to:
  - 'src/client/UI/**/*.luau'
triggers: []
keywords: []
replaces: []
created: 2026-10-21
updated: 2026-10-21
---

**Do:** Start every UI script with `--!strict` on its first line.
**Not:** Leave a UI script in nonstrict mode or without a mode line.
**Because:**

## Examples

## Evidence
- 2026-10-21 · stated · session 33704e42 · "strict-mode with applies_to as the gate probe"
- roblox-ui's `CLAUDE.md` already requires `--!strict` on every `.luau` file, and `check.sh` fails without it.
