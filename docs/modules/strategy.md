# Strategy

The Strategist decides **what to make and when**, so each filming session is spent on the pieces most likely to grow your business.

| | |
|---|---|
| Agent | Strategist (`St`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | Research data; your Brand Kit |
| Brand Kit files | `brand/pillars.md`, `brand/proof-inventory.yaml`, `brand/offers.md`, `brand/brand.yaml` |

## What it does

### Lanes

Your content is split into **lanes**, each with a weekly quota and a funnel stage. Lanes live in the front matter of `brand/pillars.md`:

```yaml
---
lanes:
  - id: client-proof
    name: Client proof
    weeklyQuota: 2
    funnelStage: bofu
    description: A real result, with the numbers from proof-inventory.yaml.
  - id: myth-bust
    name: Myth bust
    weeklyQuota: 2
    funnelStage: tofu
    description: A belief your buyers hold that costs them money.
---
```

Your preset gives you a starting set. Change them any time.

### Funnel mix

The Strategist keeps a target mix of awareness, consideration and decision content (TOFU/MOFU/BOFU, 50/30/20 by default, set in `brand/brand.yaml`) measured over your recent posts, and matches a call-to-action style to each stage.

### Angles, structures and cooldowns

- An **angle bank**: one main angle plus sub-angles.
- **Seven story structures**, used on about one in three ideas so your content doesn't all sound the same.
- **Cooldowns** on topics and templates, and a **rejected concepts** list that grows every time you say no.

### Proof inventory

`brand/proof-inventory.yaml` lists your case studies, client wins, FAQs, objections, processes and builds. Pickers rotate through it with cooldowns, so you don't tell the same story every week. It is the **only** allowed source of numbers for proof content. Clients are never named without consent recorded in the file.

### Remix first

Most of each slate remakes posts that already proved themselves, instead of ideas nobody has tested. About 70% of the pieces (`remixShare`) are **remixes** of one specific proven post:

- a competitor's outlier (a post that beat that creator's own normal), a competitor's pinned reel, or any competitor reel past 500K views (`bigViews`): proven whatever its age, or
- one of your own breakouts (a post that beat your median and passed 10K views: "do that again, new angle").

Sources are ranked by absolute views first (a reel that pulled 800K beats a post that did 5x a tiny normal), then how far they beat their creator's normal, how recent they are, how close they are to your niche (your lanes, pillars, offers and audience words) and the tier you gave the creator; a ready teardown nudges a post ahead. When a creator posted the same video more than once, only the best copy counts. A post is skipped once it's taken: a live remix of it exists, or a piece that cited it was filmed or approved. An older idea that only cited a post and never got past a draft doesn't block a proper remix of it. Your own breakouts stay eligible for a year; competitor posts fade after a few weeks.

Each remix keeps a real reference to its source: the link, views and times-normal ("Based on @handle's reel, 1.2M views, 14x their normal"), and a proof item so the Copywriter swaps in your numbers. The rest of the slate is what your lanes require: the weekly offer piece, fresh news, and talking heads when there aren't enough proven posts. If a remix's source hasn't been torn down yet, the Strategist asks the Analyst for its teardown and the script starts as soon as it is in. A remix is never written without its source's blueprint: the script waits (and asks for the teardown again if one failed), and after two failed teardowns it stops and says so instead of writing something generic. Once the blueprint is in, a placeholder title ("Remix: your 2.1K-view instagram post") becomes the blueprint's topic.

### The daily "Film today" brief

One morning document and one notification with the pieces worth filming today: outlier remixes first, then news reels, talking heads and offer pieces. Each comes with a header, a script outline, a caption, a keyword and a lead magnet. News pieces carry a deadline ("film within 24 hours"). A **batch-day** edition plans a whole week for one filming session.

### Feedback weighting

The Strategist's picks are weighted by what has worked. Until you have about 20 posts of your own, competitor signals lead; after that, your own data does. A share of picks (20% by default) is always kept for exploration.

## What you'll see

- The brief in Telegram or Discord each morning, and on demand with `/attention:brief`.
- Ideas in your content list with lane, funnel stage, angle and deadline.

## Approvals

The brief is a suggestion; nothing is made until you pick. Changes to lanes or the proof inventory are Brand Kit changes, which you approve.

## Settings

`modules.strategy.settings` holds things like the exploration share and how many pieces the brief proposes. The funnel mix lives in `brand/brand.yaml`.

Remix settings:

| Setting | Default | What it does |
|---|---|---|
| `remixShare` | `0.7` | Share of each slate that remakes a proven post. `0` turns remix-first off. |
| `remixSources.maxAgeDays` | `30` | Competitor posts older than this aren't remixed. |
| `remixSources.ownMaxAgeDays` | `365` | How long your own breakouts stay remixable. |
| `remixSources.minX` | `2` | How many times their normal a competitor post must reach. |
| `remixSources.ownMinX` | `2` | How many times your median views your own post must reach. |
| `remixSources.ownMinViews` | `10000` | Views your own post needs whatever your median, so a small post never outranks a competitor reel that pulled hundreds of thousands. `0` turns the bar off. |
| `remixSources.bigViews` | `500000` | A competitor reel with this many views is proven whatever their normal. |
| `remixSources.provenMaxAgeDays` | `365` | How long pinned and big-view competitor reels stay remixable. |
| `remixSources.halfLifeDays` | `14` | Competitor posts lose half their pull every this many days. |
| `remixSources.waitForBlueprintMinutes` | `30` | When a remix's source has no blueprint yet, its script checks back after this long (the teardown normally starts it sooner). It never starts without one. |

## Limits

- The brief is only as good as your proof inventory. A thin inventory means more generic ideas.
- Lanes with a quota of 0 are kept but never picked.
