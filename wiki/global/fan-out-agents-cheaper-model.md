---
type: rule
domain: global
kind: taste
basis: inferred
topic: delegation
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
  - 'workflows'
  - 'fan-out'
  - 'parallel agents'
  - 'ultracode'
created: 2026-10-23
updated: 2026-10-25
---

**Do:** Set an explicit cheaper model (Sonnet or Haiku) on every fan-out agent of a Workflow or subagent batch before launch, unless a domain rule pins that agent's model (the UI reviewer); keep the session's model for synthesis.
**Not:** Launch a batch that inherits the session's model.
**Because:**

## Examples

## Evidence
- 2026-10-23 · correction · session 6507d6df · "all the agents are running as fable 5.1." (a-858a959e)
