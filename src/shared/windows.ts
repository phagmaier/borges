export const developmentBooks = [
  { id: "sample-pdf", title: "Sample PDF" },
  { id: "sample-epub", title: "Sample EPUB" },
  { id: "image-pdf", title: "Image-only PDF" },
  { id: "fixed-epub", title: "Fixed EPUB" },
  { id: "font-epub", title: "Obfuscated-font EPUB" },
] as const;

export type DevelopmentBook = (typeof developmentBooks)[number];

export type DevelopmentWindow =
  | { kind: "library" }
  | { kind: "reader"; book: DevelopmentBook };
