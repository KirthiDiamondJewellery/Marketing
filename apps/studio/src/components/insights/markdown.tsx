import type { ReactNode } from "react";

/**
 * A tiny, safe Markdown renderer for agent-written reports (post-mortems): headings, paragraphs, bullet lists,
 * **bold** and `code`. No HTML passthrough, so nothing in the text can inject markup.
 */
export function Markdown({ source, skipFirstHeading = false }: { source: string; skipFirstHeading?: boolean }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  let skipped = !skipFirstHeading;
  const flush = () => {
    if (para.length) {
      const text = para.join(" ");
      const gap = /^\*\*GAP:?\*\*/i.test(text) || /^GAP:/i.test(text);
      blocks.push(
        <p key={blocks.length} className={gap ? "rounded-md bg-surface-2 px-3 py-2 text-small text-fg-2" : "text-small text-fg-2"}>
          {inline(text)}
        </p>,
      );
      para = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="flex flex-col gap-1.5">
          {list.map((li, i) => (
            <li key={i} className="relative pl-4 text-small text-fg-2 before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-fg-3">
              {inline(li)}
            </li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      if (!skipped) {
        skipped = true;
        continue;
      }
      blocks.push(
        <h4 key={blocks.length} className="text-small font-medium text-fg">
          {inline(h[2] ?? "")}
        </h4>,
      );
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) flush();
      list.push(li[1] ?? "");
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A bold-only line acts as a subheading ("**What worked**").
    const sub = /^\*\*([^*]+)\*\*$/.exec(line.trim());
    if (sub) {
      flush();
      blocks.push(
        <h4 key={blocks.length} className="mt-1 text-small font-medium text-fg">
          {sub[1]}
        </h4>,
      );
      continue;
    }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  return <div className="flex flex-col gap-2.5">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={m.index} className="font-medium text-fg">{tok.slice(2, -2)}</strong>);
    else out.push(<code key={m.index} className="rounded-sm bg-surface-2 px-1 font-mono text-[12px] text-fg">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
