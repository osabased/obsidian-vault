---
type: page
domain: global
topic: evals
summary: How to size an eval of a skill or prompt. Run a cheap check first and spend only where it misses. Test the winner's mechanism in the cheap prompt on a case where it should hurt. Probe a trigger the gate can't see in the real setup, with a control, and rerun the old triggers on the new wording.
created: 2026-10-25
updated: 2026-10-25
---

The user weighs eval spend closely. The standing rule is to run one cheap check first and stop there unless they ask for an A/B.

## When an A/B is wanted: screen, then compare

On 2026-10-25 (session c30afdac), the think-tank hard-sources eval was planned as a full A/B: three arms, 50–80 runs, about $40–70. After a pilot priced it, the user said "too much budget. Surely there is a more efficient way". They approved this design instead:

1. **Screen.** Run only the cheap arm, twice per case. Flag a case if either answer is wrong, a hedge, or right without the deciding fact. Grade leniently towards flagging, so the screen can only send more cases on.
2. **Compare** the expensive arm against fresh runs of the cheap one, on the flagged cases only. Fresh runs keep a screen miss that was chance from counting against the cheap arm. Add one run of each arm on the controls.
3. **Cap.** Name a total. Below it the comparison runs without asking again; above it, stop and ask.

It cost $12.89 against a $20 cap. The screen ($5.31) cleared 7 of 8 cases. The comparison ($7.58) ran on the one miss and the controls, and found the panel's one real edge there: search beyond the docs. The design gives up a measure of how often the expensive arm is wrong where the cheap one is right. That rarely changes the decision, since the cheap arm is the default.

Its limit: two screen answers miss a case where the cheap arm fails one time in three about 45% of the time. So the screen finds large gaps, not small ones.

## When the expensive arm wins: name its mechanism and test it in the cheap prompt

The comparison's tool logs showed why the panel won: it searched GitHub issues, and the cheap verify line kept to the docs. The user then asked for 3 runs of the verify line with "and any relevant bug reports" added ($2.28). All 3 found the issue and were right, at about a third of the panel's cost per run.

The user then had the same line run where the docs are right and old bug reports are stale ($1.90 with the controls). It hedged 2 times out of 3, pulled off the docs by an open but untested report. Plain verify and the panel were both right there. So the line swapped one miss for another. The panel had fetched that same open report in all four of its contexts and still said yes, so its real edge was weighing sources that disagree, not only searching wider.

Before adopting an expensive arm on the strength of a win, read the tool logs for the mechanism, and run the cheap prompt with that mechanism named. Then run that prompt on a case where the mechanism should hurt, not only on the case it was written for. Here that second run reversed the conclusion.

## When a trigger depends on a tool the gate denies: probe in the real setup, with a control

The user then asked for think-tank's description to fire when the docs and bug reports conflict, checked with the description eval. The standing gate runs haiku with web tools denied. Two prompts naming such a conflict loaded the skill 0 of 6 times on the old description, and 0 and 1 of 6 on two front-loaded wordings. Haiku answered from memory, so the gate can't see a trigger about checking sources. Committing those cases would also have turned the full gate red.

The user chose a real-session probe instead ($3.68 over four runs): Opus, web allowed, the bare question, one run per wording, with the old wording as the control. On the case where old bug reports contradict correct docs, both new wordings convened the panel once they found the conflict. The old wording read a similar issue and hedged.

The first new wording put the branch ahead of the old costly-choice trigger. That cut an old positive gate case from 6 of 6 to 6 of 9, which showed up only when the user asked for a PR and the old cases were rerun on the committed text. Appending the branch after the old triggers gave 8 of 9, and that wording shipped.

When a trigger needs a tool or context the standing gate leaves out, stop rewording after the first null result. Test it in the setting where it fires, with one run on the old wording as the control. Keep the gate's negatives, and leave out positives it can't see. Before shipping, rerun the old positives on the exact wording that ships, since a new branch can crowd out an old one.

Record: `evals/think-tank-hard-sources-2026-10-25/README.md` in the osaskills repo.

## Rules
- [[wiki/global/one-check-before-an-ab-eval|one-check-before-an-ab-eval]]
