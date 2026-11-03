/** Separate package metadata from the authored document for the read-only UI.
 * The stored skill and the instructions used by the Agent remain untouched. */
export function splitSkillDocument(content: string) {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(content);
  let body = (header ? content.slice(header[0].length) : content).trim();
  let installation = "";

  // This section is injected by our Lark installer, ahead of the official body.
  // Keep it available as installation information rather than a page of paths.
  if (/^## Shoggoth installation(?:\r?\n)+This official Feishu \/ Lark skill belongs to the CLI connector \(CLI /u.test(body)) {
    const lines = body.split(/\r?\n/u);
    let fence: { marker: string; length: number } | null = null;
    let end = lines.length;
    for (let index = 1; index < lines.length; index += 1) {
      const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(lines[index]);
      if (boundary) {
        if (!fence) fence = { marker: boundary[1][0], length: boundary[1].length };
        else if (boundary[1][0] === fence.marker && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
        continue;
      }
      if (!fence && /^ {0,3}#{1,2}(?:\s|$)/u.test(lines[index])) { end = index; break; }
    }
    installation = lines.slice(1, end).join("\n").trim();
    body = lines.slice(end).join("\n").trim();
  }
  return { body, frontmatter: header?.[1] ?? "", installation };
}

export function markdownCodeBlock(content: string, language: string) {
  const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/gu)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${content}\n${fence}`;
}
