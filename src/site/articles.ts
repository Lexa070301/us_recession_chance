import { esc } from "./html.js";

/**
 * Markdown-lite renderer for editorial page bodies stored in locale YAML.
 * Supported: `## subhead`, `> fact callout`, blank-line paragraphs, **bold**.
 * Everything else is escaped — locale text can never inject markup.
 */
export function renderArticleBody(text: string): string {
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const html = esc(para.join(" ")).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    blocks.push(`<p>${html}</p>`);
    para = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push(`<h3>${esc(line.slice(3))}</h3>`);
    } else if (line.startsWith("> ")) {
      flush();
      blocks.push(
        `<div class="factbox">${esc(line.slice(2)).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</div>`,
      );
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks.join("\n");
}
