export type BodyFormat = "storage" | "markdown";
export type BodyRepresentation = "storage" | "atlas_doc_format";

export interface ConfluenceBody {
  representation: BodyRepresentation;
  value: string;
}

export function toConfluenceBody(body: string, format: BodyFormat | BodyRepresentation = "storage"): ConfluenceBody {
  if (format === "markdown") {
    return { representation: "storage", value: markdownToStorage(body) };
  }

  return { representation: format, value: body };
}

export function markdownToStorage(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${escapeHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks.join("") : "<p></p>";
}

export function extractBodyValue(page: unknown, preferred: BodyRepresentation | "view" = "storage"): string | null {
  if (!page || typeof page !== "object") return null;
  const body = (page as Record<string, unknown>).body;
  if (!body || typeof body !== "object") return null;
  const representation = (body as Record<string, unknown>)[preferred];
  if (!representation || typeof representation !== "object") return null;
  const value = (representation as Record<string, unknown>).value;
  return typeof value === "string" ? value : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
