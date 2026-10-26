# Telegram

Telegram is the default way your agent team talks to you: the morning brief, alerts, approvals with buttons, finished videos to review, and free-form chat with the Chief of Staff.

| | |
|---|---|
| Interface | Notifier |
| Config | `providers.notifier: "telegram"` (default) |
| Keys | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Cost | Free |
| Setup level | [Level 1](../setup/level-1.md) |

AttentionOS reads your replies by **long polling**: it asks Telegram for new messages. You don't need a public address, a tunnel or a server.

## Create your bot (about 5 minutes)

1. In Telegram, open a chat with **@BotFather** (look for the blue check mark).
2. Send `/newbot`. Choose a display name (for example "My brand team") and a username that ends in `bot`.
3. BotFather replies with a **token**. Treat it like a password. Add it to your workspace `.env`:

   ```bash
   TELEGRAM_BOT_TOKEN=paste-the-token-from-botfather
   ```

4. Open a chat with your new bot and send any message, like `hi`.

## Find your chat id

**The easy way:** run `./aos doctor`. It reads the message you just sent, shows the chat it came from, and offers to save `TELEGRAM_CHAT_ID` for you.

**By hand:** open `https://api.telegram.org/bot<your-token>/getUpdates` in a browser (replace `<your-token>`). Find `"chat":{"id": ...}` in the response and copy the number into `.env`:

```bash
TELEGRAM_CHAT_ID=paste-the-chat-id
```

Want the team in a group chat instead? Add the bot to the group, send a message there, and use that group's chat id (it starts with a minus sign).

## What you'll get

- **The morning brief**, once a day.
- **Approvals** with **Approve** and **Reject** buttons under each one.
- **Finished videos** as files you can watch in the chat, with a reference like `rf-12 v1`.
- **Alerts** in plain language, deduplicated so the same alert doesn't repeat.

## Talking to your team

| You send | What happens |
|---|---|
| Press **Approve** or **Reject** | Decides that item |
| `approve ap-7` / `reject ap-7 <why>` | Decides an item by reference |
| Reply to a video with notes | Queues a revision of that edit |
| `rf-12 v2 <notes>` | Same, from anywhere in the chat |
| `brief` · `approvals` · `help` | Brief now · what's waiting · the command list |
| `quiet 21:30-07:00` · `quiet off` | Sets or clears quiet hours |
| `demo on` · `demo off` | Turns demo mode on or off |
| Anything else | Goes to the Chief of Staff |

See [ops](../modules/ops.md) for details.

## Quiet hours

During quiet hours, normal messages wait and arrive when the window ends. High-priority alerts still come through. Set them by sending `quiet 21:30-07:00`, or with `quietHours` in your config.

## Security

- AttentionOS **only accepts messages and button presses from your chat id**. Messages from anyone else who finds your bot are ignored and never reach an agent.
- Your messages are treated as instructions from you; anything forwarded from others is still just text the Chief of Staff reads carefully.
- The token lives only in `.env`, which is never committed. If it leaks, send `/revoke` to BotFather to get a new one.

## Troubleshooting

**Doctor can't find my chat id** · Send the bot a fresh message, then rerun doctor within a few minutes. Telegram only keeps unread updates for a day.

**Buttons do nothing** · Make sure only one program is reading the bot. If another tool set a webhook on the same bot, long polling stops working; create a separate bot for AttentionOS.

**Videos don't arrive** · Telegram bots can send files up to 50 MB (photos up to 10 MB). For anything bigger, the message still arrives with a note saying where the file is in your workspace, for example `media/renders/rf-12-v2.mp4`.
