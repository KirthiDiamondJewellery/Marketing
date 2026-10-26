/**
 * Converts the notifier markdown subset (*bold*, _italic_, `code`, [link](url)) into Discord markdown and
 * escapes everything else, so a caption like "2*3 = 6" or a handle like @some_name_here renders literally.
 */

/** Escapes Discord markdown in plain text. Line-start markers (#, -, >) only matter at the start of a line. */
export function escapeDiscord(text: string): string {
  return text
    .replace(/[\\*_~`|[\]]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#>-])/gm, (_m, space: string, c: string) => `${space}\\${c}`);
}

const TOKEN =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu;

export function toDiscordMarkdown(md: string): string {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    out += escapeDiscord(md.slice(last, at));
    const [, code, linkText, linkUrl, bold, italic] = m;
    if (code !== undefined) out += "`" + code.replace(/`/g, "'") + "`";
    // <url> suppresses the link preview card, which would otherwise crowd out the message.
    else if (linkText !== undefined && linkUrl !== undefined) out += `[${escapeDiscord(linkText)}](<${linkUrl}>)`;
    else if (bold !== undefined) out += `**${escapeDiscord(bold)}**`;
    else if (italic !== undefined) out += `*${escapeDiscord(italic)}*`;
    last = at + m[0].length;
  }
  return out + escapeDiscord(md.slice(last));
}
