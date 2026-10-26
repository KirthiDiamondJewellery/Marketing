# Discord

Prefer Discord? Your agent team can post the morning brief, alerts, approvals and finished videos to a Discord channel, and you can reply there.

| | |
|---|---|
| Interface | Notifier |
| Config | `providers.notifier: "discord"` |
| Keys | `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`; optional `DISCORD_OWNER_ID`, `DISCORD_PUBLIC_KEY` |
| Cost | Free |
| Setup level | [Level 1](../setup/level-1.md) |

## Create the bot (about 10 minutes)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it (for example "My brand team").
2. Open the **Bot** tab:
   - click **Reset Token**, copy the token, and keep it safe;
   - under **Privileged Gateway Intents**, turn on **Message Content Intent** so the bot can read your typed commands.
3. Open **OAuth2 → URL Generator**:
   - scopes: `bot`;
   - bot permissions: **View Channels**, **Send Messages**, **Attach Files**, **Read Message History**, **Add Reactions**.
4. Open the generated link and add the bot to your server.
5. Add the token to your workspace `.env`:

   ```bash
   DISCORD_BOT_TOKEN=paste-the-bot-token
   ```

## Find your channel id and user id

1. In Discord, open **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click the channel the team should use → **Copy Channel ID**.
3. Right-click your own name → **Copy User ID**.
4. Add both to `.env`:

   ```bash
   DISCORD_CHANNEL_ID=paste-the-channel-id
   DISCORD_OWNER_ID=paste-your-user-id
   ```

5. Set `notifier: "discord"` under `providers` in your config and run `./aos doctor`.

`DISCORD_OWNER_ID` is optional but strongly recommended: when it's set, **only your** reactions and messages count. Without it, anyone who can post in the channel can approve.

## Reactions or buttons

Discord only delivers button presses to a public **interactions endpoint**. How AttentionOS handles that:

| Setup | Approvals look like |
|---|---|
| Copilot (Levels 1–3) | Each approval gets ✅ and ❌ reactions. React ✅ to approve, ❌ to reject. Typed commands also work. |
| Autopilot worker with a public address (Level 4) | Real **Approve** and **Reject** buttons. Set `DISCORD_PUBLIC_KEY` (from the app's **General Information** tab) and point the app's **Interactions Endpoint URL** at the worker. |

## Talking to your team

Typed commands are the same as Telegram: `approve ap-7`, `reject ap-7 <why>`, `rf-12 v2 <notes>` (or reply to the video), `brief`, `approvals`, `quiet 21:30-07:00`, `quiet off`, `demo on`, `demo off`, `help`. Anything else goes to the Chief of Staff. See [ops](../modules/ops.md).

AttentionOS reads new messages in the channel by checking every minute, so there can be a short delay before a reply is picked up.

## Security

- Keep the bot in a private channel only you (and your team) can see.
- Set `DISCORD_OWNER_ID` so only you can approve.
- If the token leaks, reset it in the Developer Portal and update `.env`.

## Troubleshooting

**The bot posts but ignores my commands** · Message Content Intent is off. Turn it on in the Bot tab.

**"Missing access"** · The bot can't see the channel. Check the channel's permissions include the bot's role.

**Files don't attach** · Discord's upload limit for bots is smaller than for people (10 MB on servers without boosts). For anything bigger, the message still arrives with a note saying where the file is in your workspace.
