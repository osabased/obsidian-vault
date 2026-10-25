---
type: rule
domain: roblox-ui
kind: taste
basis: pick
topic: code
always: false
applies_to:
  - 'scripts/check.sh'
  - 'src/client/UI/**/*.luau'
triggers: []
keywords:
  - 'theme'
  - 'raw values'
  - 'check.sh'
  - 'text size'
  - 'font'
  - 'color'
created: 2026-10-24
updated: 2026-10-24
---

**Do:** Make check.sh fail on literal colors, fonts and text sizes in UI components and screens; style values come from Theme.luau.
**Not:** Leave raw style values to the reviewer, or to review.
**Because:**

## Examples

## Evidence
- 2026-10-18 · choice · session faedca55 · "Fail on raw values (Recommended)", picked over "Reviewer flags them" and "No guard" for "Should check.sh stop UI code from using raw style values instead of the theme?" (q-22137105; proposed as a-f18d3823)
