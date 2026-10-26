# Sign in to Claude

Your AttentionOS agents do their AI work through **Claude Code, on your own Claude plan** (Pro or Max). There's no separate AI bill and no API key. AttentionOS just needs to be signed in to your Claude account once.

This page shows exactly what to run, what you'll see, and how to check it worked.

## Why a separate sign-in?

AttentionOS runs inside Docker, which is like a small separate computer. It can't see the Claude Code you may already use on your laptop, because your laptop keeps that sign-in in its own secure storage. So you sign AttentionOS in once. You get a sign-in token that lasts about a year, and AttentionOS keeps it in a settings file only you can read.

## The normal way: during install

[Install](install.md) step 4: run `claude setup-token` on a machine with a browser and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. If that worked, you don't need anything on this page.

## Sign in (or sign in again)

Use this if you skipped the sign-in during install, it didn't work, chat in Studio says Claude isn't signed in, or your token has expired.

**1. Open Terminal and go to your AttentionOS folder.**

This is the stack dir (where `.env` lives), **not** your workspace folder.

```bash
cd ~/AttentionOS            # on a Mac
cd /opt/attentionos         # on Linux or a server
```

You're in the right place if `ls` shows `aos`, `docker-compose.yml` and `workspace`.

**2. Run the sign-in command.**

```bash
./aos claude-login
```

**3. Approve in your browser.** A browser window opens on claude.ai. Approve with the Claude account you want your agents to use. It must have a Pro or Max plan. If no browser opens, copy the link shown in Terminal into your browser.

**4. Wait for the confirmation.** Terminal shows your new token, checks that it works, saves it and restarts AttentionOS. Success looks like this:

```
✓ Long-lived authentication token created successfully!
…
Checking the sign-in works…
 ✔ Container attentionos-attentionos-1  Started
Claude is connected. Your agents now run on your Claude plan.
```

That's it. Go back to Studio and send the Chief of Staff a message with the chat button in the bottom-right corner. You should get an answer within about 20 seconds.

> **Keep the token private.** Terminal shows it once (it starts with `sk-ant-oat01-`). Don't paste it into chats, emails or screenshots. If you ever do, run `./aos claude-login` again to make a new one, then remove the old one in your Claude account settings.

## Check it's working

From your AttentionOS folder:

```bash
./aos doctor                          # the "Claude Code" lines should both be ticked
./aos claude -p "Reply with: connected"   # should print: connected
```

## On a server without a browser

`./aos claude-login` notices there's no browser and walks you through it from any device:

1. It prints a link. Open it on your phone or laptop and approve.
2. Claude shows a code. Paste it back into the server's terminal.
3. Claude shows your token. Paste it when asked.

Or make the token on your own computer and paste it in. This works anywhere:

```bash
# On any computer with a browser and Claude Code installed:
claude setup-token
```

Copy the token it prints. On the server, open the `.env` file in the AttentionOS folder and set this line (add it if it's missing):

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…your token…
```

Then restart:

```bash
./aos restart
```

## If something goes wrong

| What you see | What to do |
|---|---|
| Studio chat: *"Claude's sign-in isn't working"*, or a run fails with *"OAuth access token is invalid"* or *"401"* | Run `./aos claude-login` again. If it still fails, make the token on your computer with `claude setup-token` and paste it into `.env` as above. |
| `./aos: No such file or directory` | You're in the wrong folder. `cd ~/AttentionOS` (Mac) or `cd /opt/attentionos` (Linux), then try again. |
| *"Docker isn't running"* | Open OrbStack or Docker Desktop, wait until it's running, then try again. |
| The browser says your account needs a plan | AttentionOS runs on Claude Pro or Max. Upgrade at claude.com/pricing, then run `./aos claude-login` again. |
| *"You've hit your Claude plan's usage limit"* | Your plan's limit resets after a while. Agents pick the work back up when you try again. |
| No token appears, or Terminal says *"No token saved"* | Nothing changed. Run `./aos claude-login` again and approve in the browser. |

## Prefer an API key?

Agents can also run on an Anthropic API key, billed per use, instead of your Claude plan. See [How your agents run](copilot-vs-autopilot.md).
