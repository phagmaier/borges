/** Literal, case-insensitive matches with offsets in the original Unicode text. */
export function* literalMatches(text: string, query: string) {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
    const start = match.index;
    const end = start + match[0].length;
    yield {
      start,
      end,
      excerpt: text.slice(Math.max(0, start - 40), end + 60),
    };
  }
}

/** Match existing DOM text, excluding styles/scripts. Ranges also support cross-node phrases. */
export function* textMatches(doc: Document, root: Node, query: string) {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("script, style")) continue;
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node: node as Text, start, end: text.length });
  }
  for (const { start, end, excerpt } of literalMatches(text, query)) {
    const first = nodes.find((item) => item.end > start);
    const last = nodes.find((item) => item.end >= end);
    if (!first || !last) continue;
    const range = doc.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    yield { range, excerpt };
  }
}
