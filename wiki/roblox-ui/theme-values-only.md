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
triggers:
  - 'Color3\s*\.\s*(?:new|fromRGB|fromHex|fromHSV)\b'
  - 'BrickColor\s*\.'
  - 'Font\s*\.\s*(?:new|fromEnum|fromName|fromId)\b'
  - 'Enum\s*\.\s*Font\s*\.'
  - '(?:Min|Max)?TextSize\s*=\s*\d'
  - '(?:Color3|BrickColor|Font|TextSize)\\'
keywords:
  - 'theme'
  - 'raw values'
  - 'check.sh'
  - 'text size'
  - 'font'
  - 'color'
  - 'Theme.luau'
  - 'hardcoded'
  - 'hard-coded'
  - 'literal colors'
  - 'raw colors'
created: 2026-10-24
updated: 2026-10-26
---

**Do:** Take colors, fonts and text sizes from Theme.luau in UI components and screens, and make check.sh fail on literals.
**Not:** Write literal style values in UI code outside Theme.luau, or leave them to the reviewer.
**Because:**

## Examples

## Evidence
- 2026-10-18 · choice · session faedca55 · "Fail on raw values (Recommended)", picked over "Reviewer flags them" and "No guard" for "Should check.sh stop UI code from using raw style values instead of the theme?" (q-22137105; proposed as a-f18d3823)
