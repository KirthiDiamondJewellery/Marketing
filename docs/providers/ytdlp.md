# yt-dlp

[yt-dlp](https://github.com/yt-dlp/yt-dlp) is a free, open-source command-line tool that reads public video pages. AttentionOS uses it for TikTok and YouTube research and to download a post's video for a teardown or transcript.

| | |
|---|---|
| Interface | Scraper (and media download for teardowns) |
| Config | `providers.scraper: "ytdlp"` |
| Key | None |
| Cost | Free |
| Setup level | [Level 1](../setup/level-1.md) |

## Set up (about 3 minutes)

`./aos doctor --fix` installs yt-dlp for you through `uv`. To install it yourself:

| System | Command |
|---|---|
| macOS | `brew install yt-dlp` |
| Any system with uv | `uv tool install yt-dlp` |

Keep it up to date; sites change often and old versions break:

```bash
uv tool upgrade yt-dlp
```

## What it's good for

- Public TikTok and YouTube Shorts metrics and captions.
- Downloading a single post's video so the Analyst can transcribe it and write a teardown.

## Limits

- Instagram support is unreliable without logging in, and AttentionOS never logs in as you. Use [Apify](apify.md) or the [Instagram Graph API](iggraph.md) for Instagram.
- No comments by default, so "comment gold" isn't available through yt-dlp.
- Downloads are for analysis only. Never repost someone else's video; AttentionOS keeps downloaded media in your gitignored `media/` folder and never uses it in your edits.

## Platform terms

Reading public pages with a tool may conflict with a platform's terms. AttentionOS shows a notice and asks you to acknowledge it once (`acknowledgements.scrapingTerms`) before the first scan.
