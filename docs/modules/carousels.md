# Carousels

Branded multi-slide posts, with a hard spending cap on any generated images.

| | |
|---|---|
| Agent | Art Director (`Ad`) |
| Tier | Opt-in |
| Status | Planned for v0.4 |
| Needs | Optional image provider (OpenAI or Gemini); template-only works without one |
| Brand Kit files | `brand/house-style.md`, `brand/brand.yaml` |

## What it does

- A **layout library** using your brand palette and fonts.
- **Watermarks composited in code**: page counter, avatar and handle, placed the same way every time.
- A **two-phase flow**: the copy and layout are approved first, and only then is any money spent on images. A hard daily cap (`budgets.imagesDailyUsd`) stops runaway spend.
- Real logos from open icon sources, and a photo-rotation log so the same photo doesn't appear every week.
- 4:5 static slides and animated-slide variants.

## Approvals

Two: one before image spend, and one for the finished carousel.

## Settings

Turn it on with `modules.carousels.enabled: true`. Choose an image provider with `providers.imageGen` (`none`, `openai` or `gemini`).

## Limits

- Not in v0.1.
- Generated images are never used for proof. Numbers still come only from your proof inventory.
