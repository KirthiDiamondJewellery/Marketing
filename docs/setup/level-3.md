# Level 3: publish and engage

**Time:** about 20 minutes on top of [Level 1](level-1.md) ([Level 2](level-2.md) is optional, but it's what makes videos to publish) · **Cost:** Zernio is free for your first 2 accounts, then $6 each for accounts 3–10

By the end of this guide:

- when you **approve a video, it's scheduled** to every platform you chose, with a caption written for each one;
- your **Instagram feed** posts come to you as "you post it" reminders, so you can add trending audio;
- every post has a **comment keyword**: someone comments the word, gets a DM with a link to a free guide, and becomes a lead;
- every link is **tracked**, so you can see which post produced which lead and sale;
- your post **numbers flow back** automatically, so Analytics and the learning loop have data from day one.

---

## Before you start

| You need | Why | Cost |
|---|---|---|
| Level 1 done | Publishing uses your scripts, captions and keywords | — |
| A [Zernio](https://zernio.com) account with your social accounts connected | Publishing, comment-to-DM and analytics | First 2 accounts free |
| Instagram as a business or creator account | Needed for DMs | Free |
| A page on your website for guides (optional) | Where lead magnets live | — |

Already pay for Blotato? It's a supported alternative: see [Blotato](../providers/blotato.md). Rather post everything yourself? The `manual` publisher gives you the files and captions and sends nothing.

---

## Step 1. Connect Zernio (about 8 minutes)

If you added your Zernio key during setup (the Keys step) and your accounts show **Connected**, skip to step 2.

1. Sign up at [zernio.com](https://zernio.com) and connect your social accounts there (Instagram, TikTok, YouTube, LinkedIn and so on).
2. In Zernio, open **Settings → API** and create a key.
3. In Studio, open **Settings → Connections and keys** and add it as `ZERNIO_API_KEY`. Or go back to the Keys step at `/setup?step=keys`, paste it and press **Save and check**: Studio lists the accounts Zernio can see and matches them to your handles.

If an account shows **Not connected yet** or **Needs reconnecting**, fix it inside Zernio, then press **Refresh**. Details: [Zernio](../providers/zernio.md).

## Step 2. Turn on publishing (1 minute)

Open **Settings → Modules** and switch on **Publishing**. (**Production**, the daily loop, is already on and uses publishing as soon as it's there.) If a change doesn't show up right away, run `./aos restart` from your AttentionOS folder.

## Step 3. Check your posting plan (about 3 minutes)

Your preset set how often you post and at what times on each platform. It lives in your workspace config, `config/attentionos.config.ts`, under `modules.publishing.settings`. To change it in plain words ("no posts on Sundays", "LinkedIn only on weekdays"), ask the Publisher in Claude Code:

```bash
./aos claude
```

```
/attention:publish show me my posting plan for next week
```

**Instagram feed defaults to "you post it".** Trending audio can't be added through any API, so for your Instagram feed, AttentionOS sends you the finished file and caption an hour before the time slot, and you post it from your phone in about 30 seconds. If you don't need trending audio, set `instagram: { autopost: true }` under `modules.publishing.settings` and Instagram posts go out on their own like the other platforms.

## Step 4. Turn on keyword DMs (about 5 minutes)

1. Open **Settings → Modules** and switch on **Community**.
2. Under **Notices**, read **Automated replies in DMs** and switch it on. Community waits until you do. What the notice covers: [Notices](../notices.md).
3. Tell it where guides should live. If you have a site, set `cta.siteUrl` in `brand/brand.yaml` (open **Brand Kit** in Studio). A Google Doc or a Notion page also works.

From now on, each piece gets its own keyword. The rules are enforced in code: 4–9 letters, never reused, no word that contains or is contained in another keyword, and never a word from the script itself. When a post goes live, a comment-to-DM automation for that post is created through Zernio.

Each keyword points to a short guide in your house format. The guide link is tracked, and can sit behind an email form so new leads go straight into your contacts (or your CRM: see [CRM](../providers/crm.md)). New DMs and comments show up in **Inbox**, sorted Hot, Warm and Cold, with draft replies that wait for your OK.

## Step 5. Approve your first video and watch it schedule (about 4 minutes)

1. Open **Edit** and pick a finished video under **Ready for you**.
2. Read the **caption per platform**. Each one is written from the same transcript: Instagram carries the keyword; TikTok and YouTube use "DM me WORD" or "link in bio"; YouTube titles stay under 100 characters. Edit any of them in place.
3. Press **Looks good**, then **Schedule**. Check the platforms and the time slots the Publisher picked (**Next open slot on each platform**), or choose **Pick a time**. Untick a platform to skip it. Instagram feed shows **You post it**.
4. Press **Schedule on 3 platforms** (or **Schedule at this time**).

Behind the scenes, the Publisher checks every post against your connected accounts and each platform's rules **before** anything is sent, then schedules it in Zernio. Each post has its own key, so nothing is ever posted twice, even if something is retried. Scheduled posts show in **Calendar**. If a platform fails, the video shows under **Ready to post** on Calendar with the reason and **Try again**. More: [Your daily workflow](../daily-workflow.md#6-approve-and-schedule).

### What success looks like

- A post shows as **scheduled** in Studio and in Zernio.
- Commenting the keyword from a second account gets a DM with your tracked link within a minute or two.
- A day later, **Analytics** shows the post's first numbers.

### Tracked links

Every post's links carry `utm_content=<keyword>_<post number>`. When someone clicks through, signs up or books, **Analytics → Leads and sales** credits the post that brought them. How it's counted: [Analytics](../analytics.md).

---

## Troubleshooting

**The DM didn't arrive** · Check that the comment matches the keyword exactly, that your Instagram is a professional account, and that no other comment-to-DM tool is connected to the same account. The [Zernio page](../providers/zernio.md) lists known limits.

**A post was rejected before sending** · That's the check doing its job. The video shows under **Ready to post** on **Calendar**, naming the platform and the problem; fix it (often a reconnect in Zernio) and press **Try again**. Nothing was sent.

**Approved, but "no publisher is connected"** · Add your Zernio key (step 1) and switch on Publishing (step 2), then press **Try again** on the video under **Ready to post** on Calendar if it shows one.

**Numbers take a while to appear** · Metrics sync on a schedule. For instant updates, set up webhooks ([Level 4](level-4.md#step-5-instant-updates-optional)).

**I want to cross-post a reel that's already on Instagram** · Ask the Publisher to "backfill" it (`/attention:publish backfill <the post>`). Comment-keyword calls to action are swapped for a link line on platforms without DMs.

**Trial reels** · The [trial reels](../modules/trial-reels.md) module is on in a new workspace and turns a clean reel into a day of Instagram trial-reel variations. Scheduling them needs Zernio and the trial reels [notice](../notices.md), which you accept once.

Next: [Level 4: Autopilot, your phone and 24/7](level-4.md).
