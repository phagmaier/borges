import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "@playwright/test";
import type { BorgesApi } from "../../src/shared/runtime";
import { expect } from "./desktop";

// Shared helpers for native tests against a seeded catalog: direct read-only
// catalog checks and opening a catalog book from the library window.

export function catalog<T>(
  profile: string,
  read: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(
    join(profile, "library", "catalog.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export interface Stored {
  status: string;
  generation: number;
  revision: string;
  page: number | null;
  cfi: string | null;
  sequence: number | null;
  fontSize: number | null;
}
export function stored(profile: string, bookId: string): Stored {
  return catalog(profile, (database) => {
    const row = database
      .prepare(
        `SELECT b.reading_status AS status, b.session_generation AS generation,
           b.current_revision_id AS revision, p.pdf_page AS page,
           p.epub_cfi AS cfi, p.sequence AS sequence, s.font_size AS fontSize
         FROM books b
         LEFT JOIN positions p ON p.revision_id = b.current_revision_id
         LEFT JOIN reader_settings s ON s.book_id = b.id
         WHERE b.id = ?`,
      )
      .get(bookId);
    if (!row) throw new Error(`no book ${bookId}`);
    return { ...row } as unknown as Stored;
  });
}

/** A book's open button in the library window's results (grid or list). */
export function bookButton(library: Page, title: string) {
  return library
    .getByRole("list", { name: "Books" })
    .getByRole("button", { name: title, exact: true });
}

export async function openCatalogReader(
  application: ElectronApplication,
  title: string,
) {
  const library = await application.firstWindow();
  const opened = application.waitForEvent("window");
  await bookButton(library, title).dblclick();
  const reader = await opened;
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready");
  return { library, reader, ui };
}

/** Wait until the reader shell shows an acknowledged save. */
export async function acknowledged(reader: Page, atLeast = 1) {
  await expect
    .poll(async () =>
      Number(
        await reader.getByTestId("save-status").getAttribute("data-sequence"),
      ),
    )
    .toBeGreaterThanOrEqual(atLeast);
}

type Library = BorgesApi["library"];
export type Method = {
  [K in keyof Library]: Library[K] extends (
    ...args: never[]
  ) => Promise<unknown>
    ? K
    : never;
}[keyof Library];

/** Call one library method in a window and return its result as data. */
export function call(page: Page, method: Method, ...args: unknown[]) {
  return page.evaluate(
    ({ method, args }) =>
      (
        window.borges.library[method] as (
          ...values: unknown[]
        ) => Promise<unknown>
      )(...args).then(
        (result) => result as { ok: boolean; value?: unknown; code?: string },
        (error: unknown) => ({ ok: false, thrown: String(error) }),
      ),
    { method, args },
  );
}

/** The value of a successful call, or a test failure naming the error. */
export async function value<T>(page: Page, method: Method, ...args: unknown[]) {
  const result = (await call(page, method, ...args)) as {
    ok: boolean;
    value?: T;
  };
  expect(result, `${method} should succeed`).toMatchObject({ ok: true });
  return result.value as T;
}
