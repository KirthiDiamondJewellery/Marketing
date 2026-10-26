---
name: linkedin-longform
description: Write a LinkedIn long-form post through research, writing, an optional visual and a scored quality rubric (8 overall, no criterion under 7) that the save tool enforces in code. Use for the LinkedIn part of the weekly text-post batch or when the owner asks for a LinkedIn post.
---

# LinkedIn long-form

Four steps, in order. Each step's output is the next step's only input.

## 1. Research

- Start from what the business actually knows: `brand/proof-inventory.yaml`, `brand/offers.md`, recent scripts (`scripting_list_recent_scripts`) and cited sources (`scripting_get_claim_sources`).
- When the topic needs outside facts, search for primary sources from the last 30 days unless the topic is evergreen. Prefer official announcements, original research and reputable outlets.
- Label every point **fact** (stated by a credible source, with a detail), **inference** (your conclusion from facts) or **opinion**.
- Find one real counterpoint: the strongest reason the thesis might be wrong or incomplete.
- No verified stat? Write "no verified stats" and don't use one. Skip stats already spent in recent scripts.

## 2. Write

- The first one or two lines carry the hook and land before the "see more" fold (about 210 characters).
- One idea per post. Short paragraphs. One concrete, save-worthy takeaway.
- Every claim traces to the research without being strengthened or generalized; outside single-source claims say whose claim they are (`claim-ledger` skill).
- Owner's voice (`brand/voice.md`), run through the `spoken-humanizer` checks that apply to writing.
- 3 to 5 niche hashtags in the hashtags list, never in the text. No links in the body; the link goes in the first comment.
- A CTA that invites a real reply, not engagement bait.

## 3. Visual (optional)

If the post gets an image, it must show the post's central claim, not just its topic; follow `brand/house-style.md`; read clearly on a phone; contain no logos or invented brand marks.

## 4. Score the rubric honestly

Score 1 to 10 each: `hook`, `clarity`, `usefulness`, `accuracy`, `formatting`, `cta`; with a visual also `concept_match`, `house_style`, `mobile_legibility`, `technical_quality`, `compliance`.

The bar is **8 overall and no criterion under 7**. Accuracy is where real defects hide: check it claim by claim. Below the bar, name the failing criterion, quote the weak line, fix it and score again.

Save with `scripting_save_text_posts` including the `rubric` scores. The tool rejects posts under the bar.
