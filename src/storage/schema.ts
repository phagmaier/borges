import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface MigrationContext {
  /** Milliseconds since the Unix epoch for this upgrade. */
  readonly now: number;
}

export interface Migration {
  /** Target `PRAGMA user_version`; versions are consecutive from 1. */
  readonly version: number;
  readonly description: string;
  /**
   * Runs inside the single upgrade transaction with foreign-key enforcement
   * off; the runner checks `foreign_key_check` before committing.
   */
  up(database: DatabaseSync, context: MigrationContext): void;
}

/** `PRAGMA application_id` identifying a Borges catalog ("Borg"). */
export const CATALOG_APPLICATION_ID = 0x426f7267;

/** SQL form of `isLibraryPath`, optionally restricted to one directory. */
function libraryPath(column: string, directory?: string): string {
  const wrapped = `('/' || ${column} || '/')`;
  return `CHECK (${column} IS NULL OR (
    ${column} <> '' AND substr(${column}, 1, 1) <> '/'
    AND instr(${column}, char(92)) = 0 AND instr(${column}, '//') = 0
    AND ${wrapped} NOT LIKE '%/./%' AND ${wrapped} NOT LIKE '%/../%'
    ${directory ? `AND ${column} GLOB '${directory}/?*'` : ""}))`;
}

const flag = (column: string) =>
  `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`;
const unit = (column: string) => `CHECK (${column} BETWEEN 0 AND 1)`;
const jsonArray = (column: string) =>
  `${column} TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(${column}) AND json_type(${column}) = 'array')`;
const id = (column: string) =>
  `${column} TEXT NOT NULL CHECK (length(${column}) BETWEEN 1 AND 64)`;

// Timestamps are integer milliseconds since the Unix epoch (UTC).
const version1 = `
CREATE TABLE library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  ${id("library_id")},
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;

-- Effective metadata and per-field manual-override provenance belong to the
-- book. A manual flag with an empty value is an intentional clear.
CREATE TABLE books (
  ${id("id")} PRIMARY KEY,
  current_revision_id TEXT NOT NULL,
  reading_status TEXT NOT NULL DEFAULT 'unread'
    CHECK (reading_status IN ('unread', 'reading', 'finished')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  ${flag("title_manual")},
  ${flag("authors_manual")},
  ${flag("subjects_manual")},
  cover_path TEXT ${libraryPath("cover_path", "covers")},
  ${flag("cover_manual")},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  -- The current revision must exist and belong to this book.
  FOREIGN KEY (current_revision_id, id) REFERENCES revisions (id, book_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- Immutable published bytes. Retired revisions remain until explicit purge.
CREATE TABLE revisions (
  ${id("id")} PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id),
  format TEXT NOT NULL CHECK (format IN ('pdf', 'epub')),
  path TEXT NOT NULL UNIQUE ${libraryPath("path", "files")},
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0),
  original_filename TEXT NOT NULL,
  extracted_title TEXT,
  ${jsonArray("extracted_authors")},
  ${jsonArray("extracted_subjects")},
  extracted_cover_path TEXT ${libraryPath("extracted_cover_path", "covers")},
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  UNIQUE (id, book_id),
  UNIQUE (id, format)
) STRICT;
CREATE INDEX revisions_by_hash ON revisions (sha256);
CREATE INDEX revisions_by_book ON revisions (book_id);

CREATE TABLE book_authors (
  book_id TEXT NOT NULL REFERENCES books (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  PRIMARY KEY (book_id, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX book_authors_by_name ON book_authors (name);

-- label_key is the application's case-insensitive normalization of label.
CREATE TABLE book_subjects (
  book_id TEXT NOT NULL REFERENCES books (id),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  label_key TEXT NOT NULL CHECK (label_key <> ''),
  PRIMARY KEY (book_id, label_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX book_subjects_by_key ON book_subjects (label_key);

-- One parent per section; deleting a section removes its branch and those
-- memberships, never books. name_key is the application's case-insensitive
-- normalization of the trimmed name.
CREATE TABLE sections (
  ${id("id")} PRIMARY KEY,
  parent_id TEXT REFERENCES sections (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name = trim(name) AND name <> ''),
  name_key TEXT NOT NULL CHECK (name_key <> ''),
  created_at INTEGER NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE UNIQUE INDEX sections_sibling_names
  ON sections (coalesce(parent_id, ''), name_key);
CREATE TRIGGER sections_reject_cycles
  BEFORE UPDATE OF parent_id ON sections
  WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'section cycle')
  WHERE NEW.parent_id = NEW.id OR NEW.id IN (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_id
      UNION SELECT sections.parent_id FROM sections
        JOIN ancestors ON sections.id = ancestors.id
        WHERE sections.parent_id IS NOT NULL
    ) SELECT id FROM ancestors
  );
END;

CREATE TABLE section_memberships (
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books (id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (section_id, book_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX section_memberships_by_book ON section_memberships (book_id);

-- Revision-specific position. The locator variant must match the revision's
-- format; sequence orders writes from one reader session.
CREATE TABLE positions (
  revision_id TEXT PRIMARY KEY,
  format TEXT NOT NULL CHECK (format IN ('pdf', 'epub')),
  pdf_page INTEGER CHECK (pdf_page >= 1),
  epub_cfi TEXT CHECK (length(epub_cfi) BETWEEN 1 AND 16384),
  epub_section INTEGER CHECK (epub_section >= 0),
  epub_fraction REAL ${unit("epub_fraction")},
  pan_x REAL NOT NULL DEFAULT 0 ${unit("pan_x")},
  pan_y REAL NOT NULL DEFAULT 0 ${unit("pan_y")},
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (revision_id, format) REFERENCES revisions (id, format),
  CHECK (
    (format = 'pdf' AND pdf_page IS NOT NULL AND epub_cfi IS NULL
      AND epub_section IS NULL AND epub_fraction IS NULL)
    OR (format = 'epub' AND pdf_page IS NULL AND epub_cfi IS NOT NULL
      AND epub_section IS NOT NULL AND epub_fraction IS NOT NULL))
) STRICT;

-- Per-book sizing. Reflowable font size and fixed-page zoom are independent
-- so a cross-format replacement keeps only the compatible setting.
CREATE TABLE reader_settings (
  book_id TEXT PRIMARY KEY REFERENCES books (id),
  font_size REAL CHECK (font_size BETWEEN 8 AND 72),
  zoom REAL CHECK (zoom BETWEEN 0.25 AND 8),
  updated_at INTEGER NOT NULL
) STRICT;

-- Deleted books and retired revisions with restore context (for example the
-- section memberships at deletion). Bytes stay until explicit purge.
CREATE TABLE trash_entries (
  ${id("id")} PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('book', 'revision')),
  book_id TEXT NOT NULL REFERENCES books (id),
  revision_id TEXT,
  trashed_at INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(context) AND json_type(context) = 'object'),
  CHECK ((kind = 'book') = (revision_id IS NULL)),
  -- A retired revision is trashed under the book that owns it.
  FOREIGN KEY (revision_id, book_id) REFERENCES revisions (id, book_id)
) STRICT;
CREATE UNIQUE INDEX trash_book_once ON trash_entries (book_id)
  WHERE kind = 'book';
CREATE UNIQUE INDEX trash_revision_once ON trash_entries (revision_id)
  WHERE kind = 'revision';

-- Interrupted file/catalog operations. IDs may name records that were never
-- committed, so they deliberately have no foreign keys.
CREATE TABLE recovery_operations (
  ${id("id")} PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('import', 'replace', 'delete', 'restore', 'purge')),
  state TEXT NOT NULL CHECK (state IN
    ('pending', 'staged', 'published', 'committed', 'failed', 'abandoned')),
  book_id TEXT,
  revision_id TEXT,
  staged_path TEXT ${libraryPath("staged_path", "staging")},
  published_path TEXT ${libraryPath("published_path")},
  detail TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX recovery_operations_open ON recovery_operations (state)
  WHERE state NOT IN ('committed', 'abandoned');
`;

/** Forward-only catalog migrations. Never edit a released entry; append. */
export const catalogMigrations: readonly Migration[] = [
  {
    version: 1,
    description: "Initial catalog",
    up(database, { now }) {
      database.exec(version1);
      database.exec(`PRAGMA application_id = ${CATALOG_APPLICATION_ID}`);
      // Library identity is independent of the root's absolute location.
      database
        .prepare("INSERT INTO library VALUES (1, ?, ?)")
        .run(randomUUID(), now);
    },
  },
  {
    version: 2,
    description: "Reader session generations",
    up(database) {
      // books.session_generation is the only reader session allowed to write
      // that book's progress; opening, reload, close, replacement and reread
      // advance it. A position records the generation/sequence that wrote it.
      database.exec(`
        ALTER TABLE books ADD COLUMN session_generation INTEGER NOT NULL
          DEFAULT 0 CHECK (session_generation >= 0);
        ALTER TABLE positions ADD COLUMN generation INTEGER NOT NULL
          DEFAULT 0 CHECK (generation >= 0);
      `);
    },
  },
  {
    version: 3,
    description: "Manual cover publication",
    up(database) {
      // Rebuild the STRICT table to extend its kind CHECK. Preserve all rows
      // and its partial index; the runner already made a verified snapshot.
      database.exec(`
        ALTER TABLE recovery_operations RENAME TO recovery_operations_old;
        DROP INDEX recovery_operations_open;
        ${version1
          .slice(version1.indexOf("CREATE TABLE recovery_operations"))
          .replace("'restore', 'purge'", "'restore', 'purge', 'cover'")}
        INSERT INTO recovery_operations SELECT * FROM recovery_operations_old;
        DROP TABLE recovery_operations_old;
      `);
    },
  },
];
