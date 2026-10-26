import type { ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for agent-written analysis (teardowns): headings, lists, paragraphs,
 * **bold**, *italic* and `code`. Text is rendered as React text, never as HTML.
 */
export function Markdown({ source, skipFirstHeading = false }: { source: string; skipFirstHeading?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let skipped = !skipFirstHeading;
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length} className="text-small text-fg-2">{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length} className={list.ordered ? "list-decimal space-y-1.5 pl-5 text-small text-fg-2 marker:text-fg-3" : "space-y-1.5 text-small text-fg-2"}>
        {list.items.map((it, i) => (
          <li key={i} className={list!.ordered ? "pl-1" : "relative pl-4 before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-fg-3"}>
            {inline(it)}
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      if (!skipped) {
        skipped = true;
        continue;
      }
      const level = h[1]!.length;
      blocks.push(
        level <= 1 ? (
          <h3 key={blocks.length} className="text-h3 font-medium text-fg">{inline(h[2]!)}</h3>
        ) : (
          <h4 key={blocks.length} className="pt-2 text-small font-medium text-fg">{inline(h[2]!)}</h4>
        ),
      );
    } else if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]!);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-3">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={m.index} className="font-medium text-fg">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={m.index} className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The first `# heading` of a Markdown doc, without a "Teardown:" style prefix. */
export function mdTitle(source: string): string | null {
  const m = /^#\s+(.*)$/m.exec(source);
  if (!m) return null;
  return m[1]!.replace(/^[A-Za-z ]+:\s*/, "").replace(/^"(.*)"$/, "$1").trim();
}
