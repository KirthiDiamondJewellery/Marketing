# Providers

AttentionOS talks to outside services through **providers**: small adapters that each implement one interface. Modules only know the interface, never the vendor, so you can switch services without changing anything else.

## Interfaces, defaults and alternatives

| Interface | What it does | Default | Alternatives | Config key |
|---|---|---|---|---|
| Publisher | Posts and schedules | [Zernio](zernio.md) | [Blotato](blotato.md), `manual` (export and notify) | `publisher` |
| Inbox | Comment-to-DM, conversations, comments | [Zernio](zernio.md) | [Blotato](blotato.md) (Instagram and Facebook), `none` | `inbox` |
| Own analytics | Your posts' numbers | [Zernio](zernio.md) | [Instagram Graph API](iggraph.md), [Blotato](blotato.md), `csv` | `ownAnalytics` |
| Scraper | Competitor posts | [Apify](apify.md) | [Instagram Graph API](iggraph.md), [yt-dlp](ytdlp.md), `none` | `scraper` |
| Trend sources | News and trends | RSS, Google News, Hacker News, Reddit, GitHub | X through Apify (planned) | `brand/sources.yaml` |
| Speech to text | Word-level transcripts | [whisper.cpp](whispercpp.md) | Parakeet (planned), OpenAI Whisper API (planned) | `asr` |
| Renderer | Video rendering | Cut engine | Motion engine (Remotion, opt-in; planned, the interface ships but doesn't render yet) | `renderer` |
| Image generation | Carousel images | `none` (templates only) | OpenAI (planned), Gemini (planned) | `imageGen` |
| Notifier | Brief, alerts, approvals, chat | [Telegram](telegram.md) | [Discord](discord.md), `console`, email (planned) | `notifier` |
| CRM | Where leads go | Built-in contacts | [Webhook, Sheets, GoHighLevel, HubSpot](crm.md) | `crm` |
| Storage | Where media lives | Local disk | S3 or R2 (planned), Supabase Storage (planned) | `storage` |
| Embeddings | Makes the knowledge store searchable by meaning | Local (`BAAI/bge-small-en-v1.5` on your CPU, no key) | OpenAI, Voyage | `knowledge.embeddings` (top level, not under `providers`) |

## Switching a provider

Open `config/attentionos.config.ts` in your workspace and change the value under `providers`:

```ts
import { defineConfig } from "attentionos/config";

export default defineConfig({
  providers: {
    publisher: "blotato",
    inbox: "blotato",
    scraper: "iggraph",
    notifier: "discord",
  },
});
```

Then add the provider's key to `.env` and run:

```bash
./aos doctor
```

Doctor checks every provider you've chosen and tells you, in plain words, what's missing.

## Keys and secrets

Keys live only in your workspace's `.env`, which is never committed. They're never logged and never shown to an agent. The workspace template's `.env.example` lists every variable the shipped providers read, each with a one-line note. The main ones:

| Variable | Used by |
|---|---|
| `DATABASE_URL` | Everything |
| `ANTHROPIC_API_KEY` | Optional: only the API engine (`runner: { engine: "api" }`). By default agents run on your own Claude Code login |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional: signs in Claude Code on a server with no browser ([how](../deploy/server.md#sign-in-to-claude)) |
| `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_PROFILE_ID` | Zernio (the last two optional) |
| `BLOTATO_API_KEY`, `BLOTATO_WEBHOOK_URL`, `BLOTATO_WEBHOOK_SECRET` | Blotato (the last two optional, for lead capture) |
| `APIFY_TOKEN` | Apify |
| `IG_ACCESS_TOKEN`, `IG_USER_ID` | Instagram Graph API |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram |
| `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID`, `DISCORD_PUBLIC_KEY` | Discord |
| `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` | CRM webhook |
| `SHEETS_WEBHOOK_URL`, `SHEETS_WEBHOOK_SECRET` | CRM: Google Sheets |
| `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` | CRM: GoHighLevel |
| `HUBSPOT_ACCESS_TOKEN` | CRM: HubSpot |
| `OPENAI_API_KEY`, `VOYAGE_API_KEY` | Optional: knowledge embeddings other than local |
| `ATTENTIONOS_WEBHOOK_SECRET` | Optional: webhooks from services without their own signature check |

## How adapters behave

- Every adapter has a **health check** that doctor runs. It never spends money.
- Errors are translated into a small set of plain categories (bad key, not found, rate limited, invalid request, unsupported, conflict, over budget, service down), so messages are consistent whatever the vendor.
- Adapters honour **idempotency keys**, so retries never double-post.
- Each adapter ships contract tests with recorded responses. No live calls run in CI.

## Platform-risk notices

Some features carry platform risk. AttentionOS asks you to acknowledge each one once before it runs:

- **Scraping** public posts (`acknowledgements.scrapingTerms`): may conflict with a platform's terms.
- **Automated DMs** (`acknowledgements.automatedDmRisk`): platforms limit automated messaging.
- **Trial reels** (`acknowledgements.trialReelsRisk`): an Instagram feature with its own rules.
- **Motion engine** (`acknowledgements.remotionLicense`, planned engine): Remotion needs a paid company license for companies with more than three people.

AttentionOS never automates a browser on a social platform and never logs in as you.

## Writing a new provider

Adapters live in `packages/providers/<kind>-<vendor>` and export a `create()` function that returns the interface from `packages/core/src/providers.ts`. See `CONTRIBUTING.md` for the checklist, and open a "provider request" issue first so we can agree on the shape.
