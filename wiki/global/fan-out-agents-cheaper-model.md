---
type: rule
domain: global
kind: taste
basis: inferred
topic: code
always: false
applies_to: []
triggers: []
keywords:
  - 'workflow'
  - 'subagent'
  - 'subagents'
  - 'deep-research'
  - 'fan out'
  - 'model'
created: 2026-10-23
updated: 2026-10-23
---

**Do:** Set an explicit cheaper model (Sonnet or Haiku) on every fan-out agent of a Workflow or subagent batch before the first launch; keep the session's model for synthesis only.
**Not:** Launch a workflow or subagent batch that inherits the session's model by default.
**Because:**

## Examples

## Evidence
- 2026-10-23 · correction · session 6507d6df · "all the agents are running as fable 5.1." (a-858a959e)
