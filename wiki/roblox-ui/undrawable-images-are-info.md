---
type: rule
domain: roblox-ui
kind: taste
basis: pick
topic: feedback
always: false
applies_to: []
triggers: []
keywords:
  - 'rhr'
  - 'image-missing'
  - 'missingAssets'
  - 'rhr check'
created: 2026-10-24
updated: 2026-10-24
---

**Do:** Have rhr check report every image it can't draw as an image-missing finding with the reason: info when Roblox would draw it (rbxasset, rbxthumb), warning when Roblox refused the id.
**Not:** List undrawable images only in missingAssets, or warn on ones that look right in Roblox.
**Because:**

## Examples

## Evidence
- 2026-10-19 · choice · session a7336903 · "Report it, as info (Recommended)", picked over "Report it, as a warning" and "Only list it in missingAssets" for "Should `rhr check` report an image that rhr can't draw as an `image-missing` finding, or only list it in the render reports' missingAssets?" (q-b1cadf37; proposed as a-fb55d51b)
