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

/** Give Chromium distinct sites for concurrent book renderers.
 * IDs are internal UUIDs or diagnostic keys. */
export function engineOrigin(book: ReaderBook): string {
  return `borges://reader-${book.source}-${book.id}.reader`;
}

export function isReaderHost(host: string): boolean {
  return /^reader-(?:catalog|fixture)-[a-z0-9-]{1,64}\.reader$/.test(host);
}

/** Engine document assigned to a reader window. */
export function engineUrl(book: ReaderBook): string {
  return book.source === "catalog"
    ? `${engineOrigin(book)}/content.html?catalog`
    : `${engineOrigin(book)}/content.html?book=${book.id}`;
}
