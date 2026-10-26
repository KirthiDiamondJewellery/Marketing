/**
 * Converts the notifier markdown subset (*bold*, _italic_, `code`, [link](url)) into Telegram MarkdownV2,
 * escaping everything else. MarkdownV2 rejects a whole message when one reserved character is left
 * unescaped, so every plain segment goes through `escapeMarkdownV2`.
 * https://core.telegram.org/bots/api#markdownv2-style
 */

const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

/** Inside `code` and ```pre``` only ` and \ need escaping. */
export function escapeCode(text: string): string {
  return text.replace(/[`\\]/g, (c) => `\\${c}`);
}

/** Inside the (...) part of a link only ) and \ need escaping. */
export function escapeLinkUrl(url: string): string {
  return url.replace(/[)\\]/g, (c) => `\\${c}`);
}

const TOKEN =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^)\s]+)\)|(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu;

export function toTelegramMarkdownV2(md: string): string {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    out += escapeMarkdownV2(md.slice(last, at));
    const [, code, linkText, linkUrl, bold, italic] = m;
    if (code !== undefined) out += "`" + escapeCode(code) + "`";
    else if (linkText !== undefined && linkUrl !== undefined) out += `[${escapeMarkdownV2(linkText)}](${escapeLinkUrl(linkUrl)})`;
    else if (bold !== undefined) out += `*${escapeMarkdownV2(bold)}*`;
    else if (italic !== undefined) out += `_${escapeMarkdownV2(italic)}_`;
    last = at + m[0].length;
  }
  return out + escapeMarkdownV2(md.slice(last));
}

/** Plain text a reader sees, used to measure caption length before rendering. */
export function stripMarkdown(md: string): string {
  return md.replace(TOKEN, (_m, code, linkText, _url, bold, italic) => code ?? linkText ?? bold ?? italic ?? "");
}
