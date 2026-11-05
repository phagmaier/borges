import { describe, expect, it } from "vitest";
import { externalLink } from "../../src/shared/links";

describe("copyable external references", () => {
  it.each([
    [
      "https://example.invalid/garden?q=cedar#leaf",
      "https://example.invalid/garden?q=cedar#leaf",
    ],
    ["HTTP://example.invalid", "http://example.invalid/"],
    ["//example.invalid/reference", "https://example.invalid/reference"],
    ["mailto:gardener@example.invalid", "mailto:gardener@example.invalid"],
    ["tel:+123456789", "tel:+123456789"],
    ["ftp://example.invalid/book.epub", "ftp://example.invalid/book.epub"],
  ])("offers %s as a plain address", (input, expected) => {
    expect(externalLink(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,book",
    "borges://app/index.html",
    "blob:borges://reader/book",
    "file:///etc/passwd",
    "Chapter%20Two.xhtml#note",
    "https://",
    "https://example.invalid/\nforged",
    `https://example.invalid/${"a".repeat(8192)}`,
    null,
    { href: "https://example.invalid" },
  ])("rejects unsafe, local, malformed or oversized input %j", (input) => {
    expect(externalLink(input)).toBeNull();
  });
});
