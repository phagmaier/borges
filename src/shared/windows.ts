export const developmentBooks = [
  { id: "sample-pdf", title: "Sample PDF" },
  { id: "sample-epub", title: "Sample EPUB" },
  { id: "image-pdf", title: "Image-only PDF" },
  { id: "fixed-epub", title: "Fixed EPUB" },
  { id: "font-epub", title: "Obfuscated-font EPUB" },
] as const;

export type DevelopmentBook = (typeof developmentBooks)[number];

/** A diagnostic fixture (no saved progress) or a catalog book. */
export interface ReaderBook {
  id: string;
  title: string;
  source: "fixture" | "catalog";
}

export type DevelopmentWindow =
  | { kind: "library" }
  | { kind: "reader"; book: ReaderBook };

/** Engine document assigned to a reader window. */
export function engineUrl(book: ReaderBook): string {
  return book.source === "catalog"
    ? "borges://reader/content.html?catalog"
    : `borges://reader/content.html?book=${book.id}`;
}
