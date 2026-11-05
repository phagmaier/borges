/** Copyable references only. Never interpret a book's URL as an app command. */
export function externalLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls at the untrusted-content boundary.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["http:", "https:", "mailto:", "tel:", "ftp:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
