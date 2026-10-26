# AttentionOS design system

How every AttentionOS surface looks, moves and speaks: the Studio dashboard, the docs, notifications, CLI output and recorded demos. Components consume the tokens below; nothing hard-codes a hex value.

## 1. Concept

**Mission control with a concierge's manners.**

AttentionOS does precise, technical work around the clock. The people using it are business owners handing over their public voice. The design holds both: the rigor of a control room and the restraint of a premium product. Users should feel calm, informed and in control.

### Principles

1. **Quiet by default, loud on purpose.** The interface is mostly neutral. Violet appears only where attention is genuinely needed: a decision waiting on the user, an agent actively working, or the single primary action on a screen.
2. **Show the work, not the wiring.** "Drafted 3 scripts for Thursday", never "Job 4812 completed". Technical detail is one click away.
3. **The human has the final word.** Approvals, overrides and pauses are always visible and one step away. Autonomy is granted by the user, and the UI makes that grant legible.
4. **Premium is subtraction.** More space, fewer borders, fewer colors, fewer words. Before shipping a screen, remove one thing.
5. **Content is the hero.** The posts, videos and replies the agents produce are the product. Chrome recedes so the work can be judged at a glance.

### The Attention Signal

The one signature device is the **Attention Signal**: a 2px violet line marking where something is happening or needs the user. It is the active edge of a working agent, the leading edge of a progress bar, the marker beside an item awaiting approval, and the current-time line on the calendar. It is the only place motion and color combine, and it is never decorative.

## 2. Color

Deep neutral surfaces with concentrated violet taken from the AOS mark, plus a restrained champagne. Dark mode is the default; light mode is fully supported.

### 2.1 Core palette

| Name | Hex | Role |
|---|---|---|
| Violet action | `#7838E8` | Primary actions, the Signal, selected states (dark) |
| Violet hover | `#8847EF` | Primary button hover (dark) |
| Violet foreground | `#AD78FF` | Links, active icons, focus rings, text on violet tint (dark) |
| Violet tint | `#241734` | Selected navigation and soft brand areas (dark) |
| Violet deep | `#6A2BDB` / `#5A1FC2` | Primary action and hover/text in light mode |
| Brand gradient | `#B566FF` → `#8139FA` → `#5818D2` | Artwork and small accents only, never body text or buttons |
| Champagne | `#C9A96E` | Rare premium accents: milestones, report dividers |
| Canvas | `#08070B` | App background (dark) |
| Surface | `#111016` | Sidebar, cards, tables (dark) |
| Text primary | `#F6F3FC` | Main labels, headings, values (dark) |

### 2.2 Semantic tokens

```css
:root,
[data-theme="dark"] {
  --bg: #08070B;
  --surface-1: #111016;
  --surface-2: #19161F;
  --surface-3: #211C2B;
  --border: #2C2637;
  --border-strong: #463D54;
  --text-primary: #F6F3FC;
  --text-secondary: #B9B3C7;
  --text-muted: #8E879D;
  --brand: #7838E8;
  --brand-hover: #8847EF;
  --brand-fg: #AD78FF;
  --brand-tint: #241734;
  --brand-gradient: linear-gradient(135deg, #B566FF 0%, #8139FA 55%, #5818D2 100%);
  --on-brand: #FFFFFF;
  --text-on-tint: #AD78FF;
  --accent-gold: #C9A96E;
  --success: #58D6A0;
  --warning: #F2C46D;
  --danger: #FF8A9B;
  --info: #83B9FF;
}

[data-theme="light"] {
  --bg: #FAF9FC;
  --surface-1: #FFFFFF;
  --surface-2: #F3F0F8;
  --surface-3: #FFFFFF; /* with shadow */
  --border: #E5E0EC;
  --border-strong: #CFC7DA;
  --text-primary: #111016;
  --text-secondary: #635C70;
  --text-muted: #6E6779;
  --brand: #6A2BDB;
  --brand-hover: #5A1FC2;
  --brand-fg: #5A1FC2;
  --brand-tint: #EFE8FD;
  --on-brand: #FFFFFF;
  --text-on-tint: #5A1FC2;
  --accent-gold: #A8874B;
  --success: #1F7A5A;
  --warning: #9A6312;
  --danger: #C2362B;
  --info: #2F6FC4;
}
```

Use `--brand` for fills (buttons, the Signal, selected markers) and `--brand-fg` (`text-brand-fg`) for violet text and icons, so violet copy stays readable on dark surfaces.

### 2.3 Status colors

Muted so they never compete with violet. Danger is a rose red, pulled away from the brand hue, so errors are never mistaken for brand moments.

| Token | Used for |
|---|---|
| `--success` | Published, approved, goal met |
| `--warning` | Needs review soon, rate limits, low budget |
| `--danger` | Failed publish, disconnected account, policy risk |
| `--info` | Agent thinking, scheduled, informational |

Each status has a tint background (`--success-tint` and so on) at about 12% opacity over the current surface, with text in the base color.

### 2.4 Ratios and contrast

- Aim for about 85% neutrals, 10% text and at most 5% violet on any screen. Champagne appears on fewer than one in five screens.
- Social platform colors appear only inside their 16px icons, never as fills.
- All text meets WCAG 2.2 AA. `--text-muted` (`#8E879D` dark, `#6E6779` light) passes AA for small muted text on `--bg`.
- Buttons use white text on solid `--brand` (about 5.95:1, 5.01:1 on hover). Never use the gradient behind text, and never use champagne for body text.

## 3. Typography

| Role | Family | Fallback |
|---|---|---|
| Interface | Inter | `system-ui, -apple-system, "Segoe UI", sans-serif` |
| Headings and editorial display | Sora | `Inter, system-ui, sans-serif` |
| Agent logs and raw output | Geist Mono | `ui-monospace, "SF Mono", Menlo, monospace` |

All three are licensed under the **SIL Open Font License (OFL)**. AttentionOS only ships OFL fonts.

- **Inter** carries the working interface: body, labels, controls, tables.
- **Sora** is for page and section titles (`h1`, `h2`), the wordmark, and editorial moments (`font-display`): the weekly briefing headline, large report figures, the onboarding welcome. Never in dense UI, buttons or tables.
- **Geist Mono** is for the agent activity log and raw output (captions under review, error details). Not for labels or numbers elsewhere.

### 3.1 Scale

| Token | Size / line height | Weight | Family | Use |
|---|---|---|---|---|
| `display-xl` | 56 / 60 | 600 | Sora | Weekly briefing headline, marketing hero |
| `display-l` | 40 / 44 | 600 | Sora | Report key figures, onboarding |
| `heading-1` | 28 / 34 | 500 | Sora | Page titles |
| `heading-2` | 20 / 28 | 500 | Sora | Section titles |
| `heading-3` | 16 / 24 | 500 | Inter | Card and panel titles |
| `body` | 15 / 24 | 400 | Inter | Default text |
| `body-small` | 13 / 20 | 400 | Inter | Secondary text, metadata |
| `caption` | 12 / 16 | 500 | Inter | Badges, chart axes |
| `log` | 13 / 20 | 400 | Geist Mono | Agent activity stream |

Large Sora headings use slight negative tracking (about `-0.025em` on display sizes, `-0.02em` on titles). Body tracking stays normal.

### 3.2 Rules

- Sentence case everywhere. No all-caps labels, no tracked-out eyebrow text.
- Weights 400 and 500, plus 600 for Sora display figures and the wordmark.
- Reading text under 75 characters per line.
- Tabular figures for numbers in tables and metrics.
- Never highlight a single word in a headline with color or italics.

## 4. Layout

### 4.1 Shell

Three zones: navigation on the left, the workspace in the center, the live agent stream on the right. The stream collapses to a 56px rail of monograms.

```
┌──────────┬──────────────────────────────────────────┬────────────────┐
│ Logo     │ Page title                  [Primary CTA] │ Agent stream   │
│          ├──────────────────────────────────────────┤                │
│ Home     │                                          │ ● Strategist   │
│ Calendar │                                          │   Planning     │
│ Studio   │          Workspace                       │   week 42      │
│ Inbox    │          (calendar, posts, approvals,    │                │
│ Insights │           reports)                       │ ○ Copywriter   │
│ Agents   │                                          │   Idle         │
│ Settings │                                          │                │
└──────────┴──────────────────────────────────────────┴────────────────┘
  240px                    fluid, max 1200px                 320px
```

Content is left-aligned. Center alignment is reserved for empty states and onboarding.

### 4.2 Grid and spacing

- 4px base unit; scale 4, 8, 12, 16, 24, 32, 48, 64, 96.
- 12-column workspace grid with 24px gutters.
- Page padding 32px on desktop, 16px on mobile.
- 12px between related items, 48px between sections. When in doubt, add space rather than a border.

### 4.3 Breakpoints

| Name | Min width | Behavior |
|---|---|---|
| Mobile | 0 | Single column, bottom tab bar, agent stream as a sheet |
| Tablet | 768px | Navigation collapses to an icon rail |
| Desktop | 1200px | Full three-zone shell, stream collapsible |
| Wide | 1600px | Stream pinned open |

## 5. Shape and depth

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Badges, inputs, small buttons |
| `--radius-md` | 10px | Buttons, menus, list rows |
| `--radius-lg` | 16px | Cards, panels, post previews |
| `--radius-xl` | 24px | Modals, onboarding sheets |
| `--radius-full` | 999px | Avatars, monograms, toggles |

| Level | Dark | Light |
|---|---|---|
| 0 · page | `--bg` | `--bg` |
| 1 · card | `--surface-1` + 1px `--border` | `--surface-1` + 1px `--border` |
| 2 · panel | `--surface-2` | `--surface-1` + `0 2px 8px rgba(21, 16, 26, 0.06)` |
| 3 · popover, modal | `--surface-3` | `--surface-3` + `0 12px 32px rgba(21, 16, 26, 0.12)` |

Dark mode shows depth through surface lightness, not shadows. No gradients, glows or glassmorphism; the only exception is the Signal's bloom during showcase moments.

## 6. Motion

Two tiers. **Interface motion** is fast and quiet. **Showcase motion** is a small set of cinematic moments tied to real events.

### 6.1 Interface motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover, press, toggles |
| `--dur-base` | 200ms | Menus, tooltips, tabs |
| `--dur-slow` | 320ms | Panels, modals, sheets |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Entering |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving |

- The Signal is the only ambient animation: a slow 2.4s opacity pulse (100% to 45%) on a working agent, and a steady sweep on progress bars.
- New items in the agent stream slide in 8px and fade over `--dur-base`.
- Cards, icons and sections don't animate on load.

### 6.2 Showcase motion

| Token | Value | Use |
|---|---|---|
| `--ease-signal` | `cubic-bezier(0.16, 1, 0.3, 1)` | The Signal traveling or drawing |
| `--ease-snap` | spring, stiffness 420, damping 32 | Elements locking into place |
| `--ease-cinematic` | `cubic-bezier(0.7, 0, 0.2, 1)` | Camera-style zooms and scene changes |
| `--dur-showcase` | 1200–2400ms | Full sequence |
| `--stagger` | 60ms | Delay between items in a cascade |
| `--signal-bloom` | `0 0 24px rgba(149, 74, 251, 0.5)` | Light trail on the Signal only |

Rules: motion is always earned by a real event; only the Signal blooms; every sequence is skippable with a click or `Esc` and its end state is immediately usable; only `transform`, `opacity`, `clip-path` and SVG stroke are animated, to hold 60fps.

The moments:

1. **Wake the team** (first open of the day, about 2.2s). A violet point draws the AttentionOS ring, which fractures into arcs that fly to the agent stream and become monograms, staggered. A status line types in: "Your team is online. 7 agents, 14 tasks queued."
2. **The relay** (agent handoff, about 900ms). A short comet travels from the sending monogram to the receiving one; a one-line summary slides in ("Strategist → Copywriter: brief for Thursday").
3. **Post assembly** (about 2.4s). A platform frame draws in outline, the visual resolves behind a scanline, the caption types in, and the frame snaps to a filled card.
4. **Go live** (publish, about 1.6s). The approval card compresses and releases; the Signal splits into one beam per platform; icons light in sequence; a counter rolls to "Live on 4 platforms".
5. **Command view.** A full-screen view with the brand mark inside a slowly rotating Signal ring, agents orbiting, tasks traveling as relay comets, and scheduled posts moving towards a "now" marker. Built for long recordings and live demos.
6. **Approve all** (about 1s for ten items). Cards exit right in a 60ms stagger, each leaving a brief streak; the count rolls to zero: "Queue clear. Your agents are on it."
7. **Autopilot engaged** (about 1.4s). The ring's gap closes as the Signal completes the circle, then contracts into the agent's monogram ring, which stays closed while autopilot is on.
8. **Weekly briefing reveal** (about 1.8s). The headline figure rolls up like an odometer as an underline draws beneath it; supporting metrics cascade; the chart draws left to right with the Signal as its leading point.

### 6.3 Building the moments

- Rive for the logo, wake sequence and autopilot ring.
- GSAP or Motion for sequenced UI choreography.
- SVG `stroke-dashoffset` for every Signal path; bloom as a filter on the Signal layer only.
- Canvas or WebGL only for command view.
- Keep moments in one shared `motion/` library with named exports (`wakeTheTeam`, `relay`, `goLive`) so Studio and recorded demos share timing.

### 6.4 Reel mode

A setting for recording content safely:

- **Demo mode:** masks names and handles but keeps numbers real, so no customer data appears on camera.
- **Hotkeys 1–8** trigger each showcase moment.
- **Pacing:** 100%, 75% or 50% speed.
- **Clean capture:** hides cursor, notifications and browser chrome; locks 60fps.
- **Vertical framing:** a 9:16 layout keeping the action inside the center 1080×1350 safe area and clear of the bottom 20%.
- **Loop points** for command view and the publish burst.

### 6.5 Reduced motion

Respect `prefers-reduced-motion` everywhere: the Signal becomes a static line, transitions drop to opacity only, and showcase moments resolve straight to their end state with a 200ms crossfade. Reel mode overrides this only while it is on.

## 7. The agent team

Agents are distinguished by monogram and label, never by color.

| Agent | Role | Monogram |
|---|---|---|
| Analyst | Research, measurement, and feeding lessons back | `An` |
| Strategist | What to make and when: lanes, mix, the daily brief | `St` |
| Copywriter | Hooks, scripts, captions and text posts in the brand voice | `Cw` |
| Art Director | Edits, carousels, thumbnails and quality checks | `Ad` |
| Publisher | Scheduling and posting to every connected platform | `Pb` |
| Community | Keyword DMs, reply drafts, triage, lead handoff | `Cm` |
| Chief of Staff | The user's interface: brief, chat, approvals, routing | `Cs` |

### 7.1 Monogram

A 32px circle (24px in dense lists, 56px on profiles) with the two-letter monogram in Inter 500, `--text-primary` on `--surface-3`. A working agent gets a 2px pulsing violet ring: the Signal.

### 7.2 States

| State | Indicator | Label example |
|---|---|---|
| Working | Pulsing violet ring | "Writing 4 captions for Thursday" |
| Waiting on you | Solid violet ring + count badge | "2 posts need approval" |
| Idle | No ring, `--text-muted` label | "Next run at 7:30 AM" |
| Paused | Dashed `--border-strong` ring | "Paused by you" |
| Blocked | `--danger` ring | "Instagram disconnected" |

Never show raw job ids, model names or token counts in the default view.

### 7.3 Autonomy

| Level | Config value | Meaning | UI |
|---|---|---|---|
| Review everything | `review_all` | Every output waits for approval | Default |
| Review key posts | `review_key` | Only campaign posts and sensitive replies wait | Suggested after week one |
| Full autopilot | `autopilot` | Acts and reports afterwards | Needs a confirmation dialog |

## 8. Components

### 8.1 Buttons

| Variant | Style | Use |
|---|---|---|
| Primary | `--brand` fill, `--on-brand` text | The single most important action per view |
| Secondary | Transparent, 1px `--border-strong` | Most actions |
| Ghost | No border, `--text-secondary`, hover `--surface-2` | Toolbars |
| Danger | `--danger` text; fill only in confirmation dialogs | Disconnect, delete, stop all agents |

Height 36px (32 compact, 44 on mobile), padding 0 16px, `--radius-md`, Inter 500 at 14px. One primary button per view. Labels are verb-first and name the outcome ("Approve and schedule", "Connect Instagram"), with no arrows appended. Focus ring: 2px `--brand` outline, 2px offset.

### 8.2 Approval card

The most important component: where a human signs off on agent work.

```
┌─────────────────────────────────────────────────────┐
▌ [Cw] Copywriter · drafted 12 min ago        [IG] [in] │
│                                                      │
│  ┌────────────┐   Caption preview, shown in full,    │
│  │  preview   │   with the reasoning one click away  │
│  └────────────┘                                      │
│                                                      │
│  ap-7 · Scheduled for Thu, 9:00 AM                   │
│  [Edit]  [Request changes]          [Approve]        │
└─────────────────────────────────────────────────────┘
```

- `--surface-1`, `--radius-lg`, 24px padding.
- The Signal runs along the left edge while the card awaits a decision and disappears once handled.
- The preview shows the post as it will appear, at true aspect ratio.
- "Why this post?" expands the agent's reasoning: goal, audience and the data it used.
- The short reference (`ap-7`) matches what the user sees in Telegram, Discord and Claude Code.

### 8.3 Agent stream

Each entry: monogram, a one-line summary in `body-small`, a relative timestamp in `--text-muted`. Expanding shows the detailed log in Geist Mono on `--surface-2`. Entries needing the user carry a violet dot and sort to the top.

### 8.4 Content calendar

Week view by default. Posts are compact tiles: platform icon, thumbnail, first caption line, status dot. The current time is the Signal as a horizontal 2px line. Drag to reschedule; the Publisher confirms ("Moved to Friday, 11:00 AM").

### 8.5 Inputs

Height 40px, `--surface-2` fill, 1px `--border`, `--radius-sm`. Focus: `--brand` border plus a 3px `--brand-tint` ring. Labels above in `body-small` 500; helper and error text below in `caption`. Placeholders show a real example, never "Enter text here".

### 8.6 Badges

Height 22px, `--radius-sm`, `caption` type, padding 0 8px. Tinted background with matching strong text. Platform badges use `--surface-3` with the platform icon.

### 8.7 Metrics

Metric cards use `--surface-1`, a `body-small` label in `--text-secondary`, and the value in `heading-1`. Report headline figures use `display-l` Sora. Change indicators use `--success` or `--danger` text with a small arrow, never a colored background.

### 8.8 Empty states

A short headline, one sentence, one button.

> **Connect your first account**
> Your agents need at least one social account before they can start planning.
> [Connect an account]

## 9. Data visualization

- Primary series `--brand`; comparison series `--text-secondary`; further series `--info`, `--accent-gold`, `--success`, in that order. At most five series.
- Gridlines in `--border` at 50% opacity; axis labels in `caption` `--text-muted`.
- Line charts: 2px strokes, no area fills. Bar charts: `--radius-sm` on top corners only.
- Every chart has a one-sentence takeaway above it, written by the Analyst ("Reels drove 68% of new followers this week").
- When data is too thin, say so ("GAP: fewer than 5 posts in this lane") rather than drawing a misleading chart.

## 10. Icons and imagery

- One outline icon set at 1.5px stroke (Lucide or Tabler), 16px inline and 20px in navigation, inheriting `currentColor`.
- Platform marks at 16px, only to identify platforms.
- The user's own content is the only photography. No stock photos, no robots, brains or circuitry. Agents are carried by monograms and language, not mascots.
- **Logo:** the AOS mark, a folded violet ribbon "A" with three horizontal cuts (`design/brand/aos-logo-original.png`; the tightly cropped `aos-mark.png` is used in Studio, the favicon and the README). It sits beside "AttentionOS" in Sora 600. The mark keeps its own black background; never stretch, rotate, recolor or redraw it, and give it clear space of about a quarter of its width.

## 11. Voice and copy

AttentionOS speaks like a capable chief of staff: confident, brief, clear about what happened and what's next.

- Lead with the outcome: "Published 3 posts to LinkedIn", not "Your posts were successfully published!"
- Agents speak in the third person in system UI ("Copywriter drafted 4 captions"). The product never says "I". In chat, the Chief of Staff may speak for the team in the first person plural.
- Errors say what happened and what to do: "Instagram disconnected. Reconnect to resume publishing."
- No exclamation marks in system copy. No "seamless", "unlock", "supercharge" or "leverage".
- Use the user's words: posts, scripts, replies, followers, leads. Never internal terms like jobs, runs, tokens or pipelines.
- The same rules apply to Telegram and Discord messages and to CLI output.

## 12. Accessibility

- All text meets WCAG 2.2 AA; large display text aims for AAA.
- Status is never conveyed by color alone; every dot has a label or icon.
- Visible focus rings everywhere; 44px minimum touch targets on mobile.
- Keyboard: `A` approves, `E` edits, `J` and `K` move through the approval queue.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`; a manual theme choice wins.

## 13. Do and don't

| Do | Don't |
|---|---|
| Use violet for the one thing that needs attention | Use violet for decoration or large fills |
| Separate content with space | Box every element in a bordered card |
| Show what agents did in plain language | Expose job ids, model names or token counts by default |
| Keep Sora display for editorial moments | Use display type in buttons, tables or navigation |
| Distinguish agents by monogram and name | Give each agent its own color |
| Save big motion for the eight showcase moments | Animate every card or section on load |
| Let the Signal be the only thing that glows | Add bloom or particles anywhere else |
| Use champagne sparingly | Use champagne for text, buttons or status |
| Write verb-first, outcome-named labels | Write "Submit", "OK" or "Click here" |
