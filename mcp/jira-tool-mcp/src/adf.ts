export interface AdfDoc {
  type: "doc";
  version: 1;
  content: Array<Record<string, unknown>>;
}

export function textToAdf(text: string): AdfDoc {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const content = (paragraphs.length > 0 ? paragraphs : [""]).map((paragraph) => ({
    type: "paragraph",
    content: paragraph
      ? [{ type: "text", text: paragraph.replace(/\n/g, " ") }]
      : [],
  }));

  return {
    type: "doc",
    version: 1,
    content,
  };
}

export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;

  if (record.type === "text") {
    return typeof record.text === "string" ? record.text : "";
  }

  const content = Array.isArray(record.content) ? record.content : [];
  const joined = content.map((child) => adfToText(child)).join("");
  return record.type === "paragraph" ? `${joined}\n` : joined;
}
