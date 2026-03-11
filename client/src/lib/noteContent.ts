const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyInlineFormatting(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function hasHtmlTags(content: string): boolean {
  return HTML_TAG_PATTERN.test(content);
}

export function markdownLikeToHtml(content: string): string {
  const raw = String(content || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const output: string[] = [];

  let inUnorderedList = false;
  let inOrderedList = false;

  const closeLists = () => {
    if (inUnorderedList) {
      output.push("</ul>");
      inUnorderedList = false;
    }
    if (inOrderedList) {
      output.push("</ol>");
      inOrderedList = false;
    }
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);

    if (bulletMatch) {
      if (inOrderedList) {
        output.push("</ol>");
        inOrderedList = false;
      }
      if (!inUnorderedList) {
        output.push("<ul>");
        inUnorderedList = true;
      }
      output.push(`<li>${applyInlineFormatting(bulletMatch[1])}</li>`);
      continue;
    }

    if (orderedMatch) {
      if (inUnorderedList) {
        output.push("</ul>");
        inUnorderedList = false;
      }
      if (!inOrderedList) {
        output.push("<ol>");
        inOrderedList = true;
      }
      output.push(`<li>${applyInlineFormatting(orderedMatch[1])}</li>`);
      continue;
    }

    closeLists();

    if (!line.trim()) {
      output.push("<p></p>");
      continue;
    }

    output.push(`<p>${applyInlineFormatting(line)}</p>`);
  }

  closeLists();

  if (output.length === 0) {
    return "<p></p>";
  }

  return output.join("");
}

export function normalizeContentForEditor(content: string | null | undefined): string {
  const raw = String(content || "").trim();
  if (!raw) return "<p></p>";
  if (hasHtmlTags(raw)) return raw;
  return markdownLikeToHtml(raw);
}

export function extractTextPreview(content: string | null | undefined): string {
  const raw = String(content || "");
  if (!raw.trim()) return "";

  const html = hasHtmlTags(raw) ? raw : markdownLikeToHtml(raw);

  if (typeof window === "undefined") {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const container = document.createElement("div");
  container.innerHTML = html;
  return (container.textContent || "").replace(/\s+/g, " ").trim();
}
