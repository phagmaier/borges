import { describe, expect, it } from "vitest";
import { parseSnapshot } from "../../src/readers/session";

const saved = {
  version: 1,
  revision: "known revision",
  location: {
    format: "epub",
    cfi: "epubcfi(/6/2!/4/2)",
    section: 0,
    fraction: 0.25,
    x: 0,
    y: 0,
  },
  sizing: { fontSize: 24, zoom: 1 },
};
describe("reader diagnostic snapshot boundary", () => {
  it("accepts revision-specific EPUB and PDF locations", () => {
    expect(
      parseSnapshot(JSON.stringify(saved), "known revision").location,
    ).toMatchObject({ format: "epub", fraction: 0.25 });
    const pdf = {
      ...saved,
      location: { format: "pdf", page: 3, x: 0.2, y: 0.6 },
    };
    expect(
      parseSnapshot(JSON.stringify(pdf), "known revision").location,
    ).toEqual({ format: "pdf", page: 3, x: 0.2, y: 0.6 });
    expect(
      parseSnapshot(
        JSON.stringify({
          ...saved,
          sizing: { ...saved.sizing, theme: "dark" },
        }),
        "known revision",
      ).sizing.theme,
    ).toBe("dark");
  });
  it.each([
    { ...saved, revision: "another revision" },
    { ...saved, version: 2 },
    { ...saved, location: { ...saved.location, fraction: 1.01 } },
    { ...saved, location: { ...saved.location, cfi: 17 } },
    { ...saved, location: { format: "pdf", page: 1.5, x: 0, y: 0 } },
    { ...saved, location: { format: "pdf", page: 0, x: 0, y: 0 } },
    { ...saved, sizing: { fontSize: 0, zoom: 1 } },
    { ...saved, sizing: { fontSize: 24, zoom: 900 } },
    { ...saved, sizing: { fontSize: 24, zoom: 1, theme: "blue" } },
    { ...saved, location: { ...saved.location, x: -1 } },
    null,
  ])("rejects malformed, future or foreign state: %j", (snapshot) => {
    expect(() =>
      parseSnapshot(JSON.stringify(snapshot), "known revision"),
    ).toThrow();
  });
});
