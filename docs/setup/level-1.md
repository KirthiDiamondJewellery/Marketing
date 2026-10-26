# Level 1: install, set up and get your first scripts

**Time:** about 60–90 minutes, most of it waiting while things build and your team reads your posts · **Cost to start:** $0 beyond your Claude plan (Apify's free credit covers a small setup)

By the end of this guide you will have:

- AttentionOS **running** on your computer (or a small server), with Studio open in your browser;
- AttentionOS **signed in to Claude**, so your agents work on your own Claude plan;
- a **Brand Kit** your team drafted for you: your business, offers and ideal customer from your website, and your voice from your own videos;
- your **own posts imported** with their numbers, so every future post is measured against your normal;
- **competitor outliers**: posts in your niche that did far better than that creator's usual;
- today's **"Film today" brief** and your first **scripts**, ready to film.

You never paste in your posts. You install the Docker stack once, then click through setup in Studio.

---

## Before you start

| You need | Why | Cost |
|---|---|---|
| A Mac or Linux computer with about 8 GB of memory and 10 GB free disk (Windows: [WSL 2](https://learn.microsoft.com/windows/wsl/install) with Docker Desktop), **or** a small Ubuntu server | AttentionOS runs here | — (a server is about $10–20 a month) |
| A [Claude Pro or Max](https://claude.com/pricing) plan | Your agents run on it | Your Claude plan |
| Your website address and your social handles | Your team reads them to learn your business and your voice | — |
| An [Apify](https://apify.com) account (recommended) | Reads public posts: yours (to learn your voice and your numbers) and your competitors' | Free credit each month, then about $0–29 a month |
| A [Zernio](https://zernio.com) account (optional now, needed in [Level 3](level-3.md)) | Brings in your real analytics; later it publishes your posts | First 2 accounts free |

You also need Docker ([OrbStack](https://orbstack.dev) or Docker Desktop on a Mac, Docker Engine on Linux) and to be comfortable in a terminal. No Node.js or hosted database: everything else runs in containers.

---

## Step 1. Install the stack (about 30 minutes, most of it the first build)

AttentionOS runs as a Docker Compose stack: Postgres and the app container (Studio, the worker, the video tools and Claude Code). Follow [Install](../install.md) through step 5: Docker, the source, `.env`, the Claude token, then build and start.

Running it on a server so it works 24/7 is covered in [Level 4](level-4.md). You can start on your computer and move later.

## Step 2. Check Claude is connected (about 2 minutes)

Your agents run on the Claude sign-in token in `.env` (`CLAUDE_CODE_OAUTH_TOKEN`). If you left it empty during the install, sign in now from the stack dir:

```bash
cd ~/AttentionOS && ./aos claude-login          # Linux or a server: cd /opt/attentionos
```

`./aos doctor` confirms it. Step by step, with checks and fixes: [Sign in to Claude](../claude-sign-in.md).

## Step 3. Open Studio (1 minute)

```bash
./aos open
```

Or open the address yourself:

- **http://localhost:4747** if you installed on this computer, or
- through an SSH tunnel if you installed on a server ([how](../deploy/server.md#access)).

The first time, Studio opens on **Setup**. If the page doesn't load yet, the first start can take a few minutes: `./aos status` says when Studio is healthy.

## Step 4. Let the models download (automatic, about 5 minutes)

Your team learns your voice from the **transcripts of your own videos**. Transcription runs on your own machine with a speech-to-text model of about 500 MB, plus a small search model. AttentionOS downloads both by itself in the background the first time it starts, so there's nothing to run. If you start setup before they're done, the first transcriptions simply wait for them.

## Step 5. Follow setup in Studio (about 15 minutes of your time)

Setup is seven short steps. You can leave and come back: Studio remembers where you were. Full detail: [Onboarding](../modules/onboarding.md).

1. **Welcome.** Meet your team, and three checks say whether everything they need is running (the database, Claude, the worker). If one isn't, it shows the exact command to fix it. You can keep going; steps that need AI wait until it's fixed.
2. **You.** Your website and the handles you post from (at least one). The Analyst starts reading your website as soon as you continue.
3. **Keys.** Paste your **Apify** token and, if you have one, your **Zernio** key. Each card shows where to find the key and checks it when you save. For Zernio, Studio lists the accounts it can see and matches them to your handles ("Connected as @yourname", or "Not connected yet" with what to do). Both are optional and you can add them later in **Settings**.
4. **Competitors.** Three to ten creators per platform who make the kind of posts you want to make. Type or paste handles, or press **Suggest some** and the Analyst searches for creators in your niche. If you use Apify, read the short notice about reading public posts and tick **I understand, read public posts for me**.
5. **Start.** Press **Start** and watch your team work. They pull your posts, transcribe your best 15 videos and the top competitor outliers, scan your competitors for posts that beat their usual, finish reading your website and index everything so every agent can search it. Each line updates live. It takes a few minutes; you can continue while it runs.
6. **Review.** Your drafts, side by side: **Your business** (what you do, your offers, your ideal customer, drafted from your website), **Your voice** (drafted from your own transcripts and captions), and your **Content lanes** (how many posts a week of each kind). Fix anything that's off, then press **Approve all**. Approved cards become your Brand Kit, which every agent reads before it writes.
7. **Go live.** Choose what waits for your OK (**Review everything** is the right start), whether **Autopilot** runs work on a schedule, and optionally connect **Telegram** for your phone. Press **Go live** and Studio opens **Agents**, where you can watch your team start.

> **Optional: add proof and stories.** From Review, **Add proof and stories** opens a ten-minute interview with the Chief of Staff (or go to `/setup?step=interview`). It asks for results you can prove, client stories and the objections you hear. Numbers are only kept when you say where they come from, and they go into your proof inventory, the only place agents take numbers from.

## Step 6. Your first brief and scripts (about 10 minutes)

When you go live, the Strategist plans today's filming from what your team found. Within a few minutes the **"Film today" brief** appears under **Needs your OK** on **Home**: a short list of pieces worth filming, each with a lane, an angle and a film-by time. Press **Looks good**, or tell the Strategist what to swap.

Then ask the Copywriter for the scripts. In Studio, open **Scripts**, press **New script**, then **Ask the AI**. Or open Claude Code in your workspace and ask for one script per piece:

```bash
./aos claude
```

```
/attention:script <the piece's title from the brief>
```

(Already use Claude Code on your computer? `cd ~/AttentionOS/workspace && claude` works too; see [Use Claude Code with your workspace](../../README.md#claude-code).)

The Copywriter writes each script in your voice, records where the hook came from, checks every claim against your proof, and runs the **script validator**: a hard check in code for length, banned phrases, call to action and keyword. A script only reaches you when it passes. Open it on **Scripts** and press **Approve**; then it's ready to film, with a teleprompter (**Film it**).

### What success looks like

- **Brand Kit** in Studio shows files you recognize as you.
- **Analytics → Competitors** shows your competitors' outliers.
- **Scripts** shows a script you would actually say on camera.

From here, your week is: film, upload, review, approve. See [Your daily workflow](../daily-workflow.md). Tell the Chief of Staff a correction, like "never call it cheap", with the chat button in the bottom-right corner, and it becomes a dated rule in `brand/lessons.md`, so the same mistake doesn't come back.

---

## Troubleshooting

**"Docker isn't running"** · Open OrbStack or Docker Desktop, wait until it says it's running, then `./aos start`.

**Studio doesn't load right after installing** · The first start builds everything. `./aos status` says when Studio is healthy; `./aos logs` shows what it's doing.

**Welcome says Claude isn't signed in** · Run `./aos claude-login` from your AttentionOS folder and approve in the browser, then press **Check again**. See [Sign in to Claude](../claude-sign-in.md).

**Start says "Couldn't bring in your posts"** · Check your Apify token on the Keys step (press **Check**). Private accounts can't be read. Without Apify, Zernio brings in captions and numbers but no video files, so your voice is learned from captions.

**Start says speech-to-text isn't set up** · The model is still downloading, or the download failed (no internet). Check with `./aos doctor`; `./aos doctor --fix` retries the download. Your voice is learned from captions until then.

**Competitors say "Not scanned"** · The line says why: no Apify token yet, the notice isn't ticked (Competitors step), or this month's scraping budget is used up.

**The brief doesn't appear** · The Strategist starts a minute after you go live. Open **Agents → Strategist** to see what it's doing, or run it yourself there: **Run now → Plan today's filming**.

**Anything else** · `./aos doctor` checks the whole setup and gives a plain fix for every problem. In Studio: **Settings → Checkup**. Still stuck? See the [FAQ](../faq.md).

Next: [Level 2: edit](level-2.md).
