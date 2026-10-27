---
type: page
domain: global
topic: delegation
summary: How the vault's rules bear on an orchestrator that drives child sessions (osaskills orchestrate), and which chief-of-staff practices they rule in or out.
created: 2026-10-26
updated: 2026-10-26
---

## What the vault knows

Three rules settle most design questions about delegating work to child sessions or subagents:

- [[wiki/global/fan-out-agents-cheaper-model|fan-out-agents-cheaper-model]]: every fan-out agent gets an explicit cheaper model; the session's model stays for synthesis and judgement. In orchestrate this is the `mechanical` mark on a part and the Sonnet second reader.
- [[wiki/global/live-by-default-not-approval-queues|live-by-default-not-approval-queues]]: batch what needs a decision. One gate per part, with every queued question on it, fits; a prompt per learned rule or per finding does not.
- [[wiki/global/close-against-the-standing-goal|close-against-the-standing-goal]]: at the end, name the next unbuilt piece of the original goal. Orchestrate's End step does this.

The user's global CLAUDE.md adds one outside the vault: read in full yourself any file you will act on. So the orchestrator reads the diff it sends findings on; a reader subagent is a second pair of eyes, never the only one.

## Agent's reading (2026-10-26)

Compared orchestrate (osaskills `22936ed`) with Matt Pocock's chief-of-staff (`mattpocock/skills@5beb35b`). Three earlier passes had taken most of it. What the rules above decide:

- Chief-of-staff's "all work in subagents, protect your context" collides with read-it-yourself. Keep the orchestrator's own review.
- Its "strategic track first: fix the environment before feature work" agrees with close-against-the-standing-goal. Worth taking as an environment part proposed at the split, built first.
- Its wiki with ingest, query and lint is what this vault already is for taste. Project facts go to auto memory, per AGENTS.md, so cross-run knowledge for orchestrate belongs there as dated, SHA-cited pages, not in a third store.

## Rules

- [[wiki/global/fan-out-agents-cheaper-model|fan-out-agents-cheaper-model]]
- [[wiki/global/live-by-default-not-approval-queues|live-by-default-not-approval-queues]]
- [[wiki/global/close-against-the-standing-goal|close-against-the-standing-goal]]
