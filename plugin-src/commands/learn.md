---
description: What worked, what didn't and why, with post-mortems and proposed lessons
argument-hint: "[week | month | post id]"
allowed-tools: Read, Glob, Grep
---

# Learn from results

Have the Analyst review results. Period or post: `$ARGUMENTS` (default: the last 7 days).

1. Read `config/attentionos.config.ts` for the north-star goal (for example leads per week) and judge everything against it.
2. Use the `learn_*` and `research_*` tools from the attentionos MCP server to pull post results, each post's `x` against the owner's own baseline, and feature stats (hook pattern, lane, format, angle, funnel stage, CTA type, length, posting slot, story structure).
3. Report:
   - **Headline:** one sentence on the north-star goal this period.
   - **Winners** (2x or better) and **flops** (under 0.6x) with the same depth: what was different, the likely reason, and the evidence.
   - **What to do more of and less of**, each with `n` and confidence.
   - Where the sample is too small, write an explicit `GAP:` line ("GAP: only 3 posts in the myth-bust lane, need 8 before judging") instead of guessing.
4. Offer to save post-mortems with the `learn_*` tools.
5. Propose up to three lessons as dated rules. Only write them to `brand/lessons.md` after the owner agrees (use the format from `/attention:lesson`).

Never invent or round numbers in the owner's favour. Quote what the tools return.
