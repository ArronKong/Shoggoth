// Shared lexer for the Service authority check and its explicit preview UI.
// An unfinished/quoted fence is never an executable legacy page. Other fenced
// languages are skipped as a whole, including apparent html fences inside.
export function legacyHtmlBlocks(text) {
  if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")) return [];
  const blocks = []; let open = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!open) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u);
      if (!match || (match[1][0] === "`" && match[2].includes("`"))) continue;
      open = { marker: match[1][0], length: match[1].length, html: match[2].trim().toLowerCase() === "html", lines: [] };
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u);
      if (close && close[1][0] === open.marker && close[1].length >= open.length) {
        if (open.html) {
          const html = open.lines.join("\n");
          blocks.push({ blockIndex: blocks.length, html,
            runnable: /<(?:!doctype\s+html\b|html\b|script\b|style\b)/iu.test(html) });
        }
        open = null;
      } else open.lines.push(line);
    }
  }
  return blocks;
}
