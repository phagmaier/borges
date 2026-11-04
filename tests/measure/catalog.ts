import {
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveBook, editMetadata } from "../../src/library/books.ts";
import { addFileAsNewBook } from "../../src/library/import.ts";
import {
  addBooksToSection,
  createSection,
} from "../../src/library/sections.ts";
import { openLibrary } from "../../src/storage/catalog.ts";
import {
  type RepresentativeDocument,
  representativeEpub,
  representativePdf,
} from "./representative.ts";

// A deterministic, representative 500-entry library for A13, built through the
// real import, metadata, section and archive services. The plan below is the
// oracle: expected query counts come from its construction, not from the
// query implementation.

export const CATALOG_SIZE = 500;
export const LARGE_PDF = "Representative PDF";
export const LARGE_EPUB = "Representative EPUB";

const ADJECTIVES = [
  "Quiet",
  "Hidden",
  "Northern",
  "Silver",
  "Patient",
  "Distant",
  "Burning",
  "Secret",
];
const NOUNS = [
  "Harbor",
  "Orchard",
  "Meridian",
  "Compass",
  "Cipher",
  "Garden",
  "Labyrinth",
  "Mirror",
  "River",
  "Tower",
  "Almanac",
  "Comet",
];
const FIRST_NAMES = [
  "Ada",
  "Bruno",
  "Clara",
  "Dmitri",
  "Elena",
  "Farid",
  "Greta",
  "Hugo",
  "Ines",
  "Jonas",
  "Kiri",
  "Lucia",
];
const LAST_NAMES = [
  "Okafor",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Varga",
  "Quispe",
  "Haddad",
  "Novak",
  "Brennan",
  "Castellanos",
];
const SUBJECTS = [
  "History",
  "Poetry",
  "Philosophy",
  "Mathematics",
  "Astronomy",
  "Botany",
  "Linguistics",
  "Cartography",
  "Music",
  "Architecture",
  "Economics",
  "Chemistry",
  "Theology",
  "Geology",
  "Medicine",
  "Law",
  "Drama",
  "Folklore",
  "Navigation",
  "Typography",
  "Ethics",
  "Logic",
  "Optics",
  "Zoology",
  "Agriculture",
  "Rhetoric",
  "Painting",
  "Sculpture",
  "Anthropology",
  "Archaeology",
  "Ecology",
  "Physics",
  "Statistics",
  "Psychology",
  "Sociology",
  "Cryptography",
  "Meteorology",
  "Oceanography",
  "Mythology",
  "Calligraphy",
];
const AUTHORS = FIRST_NAMES.flatMap((first) =>
  LAST_NAMES.map((last) => `${first} ${last}`),
);

/** 6 shelves × 3 topics × 2 parts: 60 nested sections. */
interface PlannedSection {
  name: string;
  parent: number | null;
}
export const SECTIONS: PlannedSection[] = [];
for (let shelf = 0; shelf < 6; shelf++) {
  const root = SECTIONS.push({ name: `Shelf ${shelf + 1}`, parent: null }) - 1;
  for (let topic = 0; topic < 3; topic++) {
    const child =
      SECTIONS.push({ name: `Topic ${topic + 1}`, parent: root }) - 1;
    for (let part = 0; part < 2; part++)
      SECTIONS.push({ name: `Part ${part + 1}`, parent: child });
  }
}
const LEAVES = SECTIONS.flatMap((section, index) =>
  section.name.startsWith("Part") ? [index] : [],
);
const TOPICS = SECTIONS.flatMap((section, index) =>
  section.name.startsWith("Topic") ? [index] : [],
);

export interface PlannedBook {
  index: number;
  title: string;
  format: "pdf" | "epub";
  /** Pages (PDF) or chapters (EPUB). */
  units: number;
  noun: string;
  authors: string[];
  subjects: string[];
  sections: number[];
  archived: boolean;
}

export const plan: PlannedBook[] = Array.from(
  { length: CATALOG_SIZE },
  (_, i) => {
    const format =
      i === 0 ? "pdf" : i === 1 ? "epub" : i % 5 < 3 ? "pdf" : "epub";
    const noun = NOUNS[i % NOUNS.length] ?? "";
    const title =
      i === 0
        ? LARGE_PDF
        : i === 1
          ? LARGE_EPUB
          : `${ADJECTIVES[i % ADJECTIVES.length]} ${noun} ${String(i).padStart(3, "0")}`;
    const authors = [AUTHORS[(i * 17) % AUTHORS.length] ?? ""];
    if (i % 4 === 0) authors.push(AUTHORS[(i * 29 + 5) % AUTHORS.length] ?? "");
    const subjects = [
      ...new Set(
        [i * 7, i * 11 + 3, ...(i % 3 === 0 ? [i * 13 + 7] : [])].map(
          (n) => SUBJECTS[n % SUBJECTS.length] ?? "",
        ),
      ),
    ];
    const sections =
      i % 10 === 9
        ? []
        : [
            LEAVES[i % LEAVES.length] ?? 0,
            ...(i % 3 === 0 ? [TOPICS[(i * 7) % TOPICS.length] ?? 0] : []),
          ];
    return {
      index: i,
      title,
      format,
      units:
        i === 0
          ? 400
          : i === 1
            ? 40
            : format === "pdf"
              ? 4 + ((i * 37) % 60)
              : 2 + ((i * 13) % 14),
      noun: i < 2 ? "" : noun,
      authors: [...new Set(authors)],
      subjects,
      sections,
      archived: i >= 2 && i % 7 === 6,
    };
  },
);

const live = plan.filter((book) => !book.archived);
const sampleAuthor = AUTHORS[17 * 3] ?? "";

/** Library-window queries with counts derived from the plan. */
export const queries = [
  { name: "all books", query: { view: { kind: "all" } }, count: live.length },
  {
    name: "title term",
    query: { view: { kind: "all" }, text: "harbor" },
    count: live.filter((book) => book.noun === "Harbor").length,
  },
  {
    name: "two terms",
    query: { view: { kind: "all" }, text: "HARBOR astronomy" },
    count: live.filter(
      (book) => book.noun === "Harbor" && book.subjects.includes("Astronomy"),
    ).length,
  },
  {
    name: "author filter, with archived",
    query: {
      view: { kind: "all" },
      author: sampleAuthor.toLowerCase(),
      includeArchived: true,
    },
    count: plan.filter((book) => book.authors.includes(sampleAuthor)).length,
  },
  {
    name: "subject filter",
    query: { view: { kind: "all" }, subject: "History" },
    count: live.filter((book) => book.subjects.includes("History")).length,
  },
  {
    name: "unfiled",
    query: { view: { kind: "unfiled" } },
    count: live.filter((book) => book.sections.length === 0).length,
  },
  {
    name: "archive",
    query: { view: { kind: "archive" } },
    count: plan.length - live.length,
  },
] as const;

export function documentFor(book: PlannedBook): RepresentativeDocument {
  if (book.index === 0) return representativePdf();
  if (book.index === 1) return representativeEpub();
  const variant = {
    seed: 0x10000 + book.index,
    opening: `${book.title} opening`,
  };
  return book.format === "pdf"
    ? representativePdf(book.units, variant)
    : representativeEpub(book.units, variant);
}

/**
 * Build the plan into an empty library root through the real services.
 * Returns the time taken.
 */
export async function buildCatalog(root: string): Promise<number> {
  const started = performance.now();
  for (const query of queries)
    if (query.count === 0) throw new Error(`Empty expectation: ${query.name}`);
  const sources = await mkdtemp(join(tmpdir(), "borges-a13-sources-"));
  const library = openLibrary({ root });
  const ids: string[] = [];
  try {
    // A few concurrent imports overlap file fsyncs with catalog commits; each
    // import is its own operation, so order does not matter.
    let next = 0;
    const importer = async () => {
      for (let book = plan[next++]; book; book = plan[next++]) {
        const source = join(sources, `${book.title}.${book.format}`);
        await writeFile(source, documentFor(book).bytes);
        const added = await addFileAsNewBook(library, source);
        if (added.title !== book.title)
          throw new Error(`Imported ${added.title} for ${book.title}`);
        ids[book.index] = added.bookId;
        await rm(source);
        editMetadata(library.database, added.bookId, {
          authors: book.authors,
          subjects: book.subjects,
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, importer));
    const sectionIds: string[] = [];
    for (const section of SECTIONS)
      sectionIds.push(
        createSection(library.database, {
          name: section.name,
          parentId: section.parent === null ? null : sectionIds[section.parent],
        }).id,
      );
    sectionIds.forEach((sectionId, index) => {
      const members = plan
        .filter((book) => book.sections.includes(index))
        .map((book) => ids[book.index]);
      if (members.length > 0)
        addBooksToSection(library.database, sectionId, members);
    });
    for (const book of plan)
      if (book.archived) archiveBook(library.database, ids[book.index]);
    return performance.now() - started;
  } finally {
    library.close();
    await rm(sources, { recursive: true, force: true });
  }
}

export interface CatalogEntry {
  id: string;
  /** Managed file, relative to the root. */
  path: string;
  size: number;
}

/** The built catalog's entries by title, read directly from its database. */
export function catalogEntries(root: string): Map<string, CatalogEntry> {
  const database = new DatabaseSync(join(root, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    const entries = new Map<string, CatalogEntry>();
    for (const row of database
      .prepare(
        `SELECT b.id AS id, b.title AS title, r.path AS path, r.size AS size
         FROM books b JOIN revisions r ON r.id = b.current_revision_id`,
      )
      .all())
      entries.set(String(row.title), {
        id: String(row.id),
        path: String(row.path),
        size: Number(row.size),
      });
    if (entries.size !== plan.length)
      throw new Error(`Expected ${plan.length} books, found ${entries.size}`);
    return entries;
  } finally {
    database.close();
  }
}

const UNREAD_ATIME = new Date("2001-01-01T00:00:00Z");

/**
 * Backdate every managed file's access time (keeping its modification time).
 * With `relatime`, the kernel then advances the access time on the next read,
 * so `readSince` reports exactly which book files were read.
 */
export async function resetAccessTimes(root: string): Promise<void> {
  const directory = join(root, "files");
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    await utimes(path, UNREAD_ATIME, (await stat(path)).mtime);
  }
}

/** Managed files (root-relative) read since `resetAccessTimes`. */
export async function readSince(root: string): Promise<string[]> {
  const directory = join(root, "files");
  const read: string[] = [];
  for (const name of await readdir(directory))
    if ((await stat(join(directory, name))).atimeMs > UNREAD_ATIME.getTime())
      read.push(`files/${name}`);
  return read.sort();
}
