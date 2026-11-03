import { describe, expect, it } from "vitest";
import { literalMatches } from "../../src/readers/text";

describe("literal reader text matching", () => {
  it("keeps original offsets when earlier Unicode characters expand under lowercasing", () => {
    expect([...literalMatches("İ chapter HARBOR", "harbor")]).toEqual([
      { start: 10, end: 16, excerpt: "İ chapter HARBOR" },
    ]);
  });
  it("treats search punctuation literally and returns each occurrence", () => {
    expect(
      [...literalMatches("a.b aXb A.B", "a.b")].map(({ start, end }) => [
        start,
        end,
      ]),
    ).toEqual([
      [0, 3],
      [8, 11],
    ]);
    expect(
      [...literalMatches("lantern lantern", "lantern")].map(
        ({ start }) => start,
      ),
    ).toEqual([0, 8]);
    expect([...literalMatches("book", "")]).toEqual([]);
  });
});
