import type { ElectronApplication, Page } from "@playwright/test";
import { bookButton, catalog, stored } from "./catalog";
import { expect, test } from "./desktop";

// Status/Archive actions and metadata editing through the library window
// (A4 through the interface). Expected states come from the spec's
// transition table; the catalog is checked directly.

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

const sidebar = (library: Page) =>
  library.getByRole("navigation", { name: "Library" });
const destination = (library: Page, name: string) =>
  sidebar(library).getByRole("button", { name, exact: true });
const bar = (library: Page) =>
  library.getByRole("region", { name: "Selected books" });

async function libraryWindow(application: ElectronApplication) {
  const library = await application.firstWindow();
  await expect(library.locator(".result-count")).toHaveText("2 books");
  return library;
}

async function shown(library: Page) {
  await expect(library.locator(".result-count")).not.toHaveText("Loading…");
  return library
    .getByRole("list", { name: "Books" })
    .locator(".title")
    .allTextContents();
}

const select = (library: Page, title: string) =>
  library.getByRole("checkbox", { name: `Select ${title}` }).check();

function book(profile: string, title: string) {
  return catalog(profile, (database) => {
    const row = database
      .prepare(
        `SELECT id, reading_status AS status, archived_at IS NOT NULL AS archived,
           title_manual AS titleManual, authors_manual AS authorsManual,
           subjects_manual AS subjectsManual
         FROM books WHERE title = ?`,
      )
      .get(title);
    return row ? { ...row } : null;
  }) as {
    id: string;
    status: string;
    archived: number;
    titleManual: number;
    authorsManual: number;
    subjectsManual: number;
  } | null;
}

async function openFrom(
  application: ElectronApplication,
  library: Page,
  title: string,
) {
  const opened = application.waitForEvent("window");
  await bookButton(library, title).dblclick();
  const reader = await opened;
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready");
  return { reader, ui };
}

test("status and Archive actions, reference opens and Start Rereading follow the transition table (A4)", async ({
  application,
  profile,
}) => {
  const library = await libraryWindow(application);

  // Finish keeps the book unarchived; Archive keeps its status.
  await select(library, "Known PDF");
  await bar(library).getByRole("button", { name: "Mark Finished" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Marked 1 book Finished.",
  );
  await destination(library, "Finished").click();
  await expect.poll(() => shown(library)).toEqual(["Known PDF"]);
  await select(library, "Known PDF");
  await bar(library).getByRole("button", { name: "Archive" }).click();
  await expect(library.getByRole("status")).toHaveText("Archived 1 book.");
  expect(book(profile, "Known PDF")).toMatchObject({
    status: "finished",
    archived: 1,
  });
  await destination(library, "All Books").click();
  await expect.poll(() => shown(library)).toEqual(["Reflowable EPUB"]);

  // An archived unread book opened for reference stays Unread and archived.
  await select(library, "Reflowable EPUB");
  await bar(library).getByRole("button", { name: "Archive" }).click();
  await destination(library, "Archive").click();
  // Archive lists the most recently archived first.
  await expect
    .poll(() => shown(library))
    .toEqual(["Reflowable EPUB", "Known PDF"]);
  const epub = await openFrom(application, library, "Reflowable EPUB");
  await expect(epub.reader.getByTestId("save-status")).toHaveAttribute(
    "data-sequence",
    /^[1-9]/,
  );
  expect(book(profile, "Reflowable EPUB")).toMatchObject({
    status: "unread",
    archived: 1,
  });
  // Unarchive keeps the status and leaves the Archive view.
  await select(library, "Reflowable EPUB");
  await bar(library).getByRole("button", { name: "Unarchive" }).click();
  await expect.poll(() => shown(library)).toEqual(["Known PDF"]);
  expect(book(profile, "Reflowable EPUB")).toMatchObject({
    status: "unread",
    archived: 0,
  });

  // A Finished, archived book opened for reference keeps both; its reader
  // moves to page 3.
  const pdf = await openFrom(application, library, "Known PDF");
  const surface = pdf.ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  const id = book(profile, "Known PDF")?.id ?? "";
  await expect.poll(() => stored(profile, id).page).toBe(3);
  expect(book(profile, "Known PDF")).toMatchObject({
    status: "finished",
    archived: 1,
  });

  // Start Rereading asks first; Cancel changes nothing.
  await select(library, "Known PDF");
  await bar(library).getByRole("button", { name: "Start Rereading…" }).click();
  const dialog = library.getByRole("dialog", {
    name: "Start rereading 1 book?",
  });
  await expect(dialog).toContainText("returns to the beginning");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(stored(profile, id)).toMatchObject({ page: 3, status: "finished" });
  await bar(library).getByRole("button", { name: "Start Rereading…" }).click();
  await dialog
    .getByRole("button", { name: "Start Rereading", exact: true })
    .click();
  await expect(library.getByRole("status")).toHaveText(
    "Started rereading 1 book.",
  );
  // Unarchived (so it leaves Archive), Currently Reading, reader at page 1.
  await expect.poll(() => shown(library)).toEqual([]);
  await expect(pdf.ui.locator("#location")).toHaveText("Page 1 of 3");
  await expect.poll(() => stored(profile, id).page).toBe(1);
  expect(book(profile, "Known PDF")).toMatchObject({
    status: "reading",
    archived: 0,
  });
  await destination(library, "Currently Reading").click();
  await expect.poll(() => shown(library)).toEqual(["Known PDF"]);
});

test("details editing marks only edited fields manual and explains invalid input", async ({
  application,
  profile,
}) => {
  const library = await libraryWindow(application);
  await select(library, "Known PDF");
  await select(library, "Reflowable EPUB");
  // Details are edited one book at a time.
  await expect(
    bar(library).getByRole("button", { name: "Edit details" }),
  ).toHaveCount(0);
  await library
    .getByRole("checkbox", { name: "Select Reflowable EPUB" })
    .uncheck();
  await bar(library).getByRole("button", { name: "Edit details" }).click();
  const dialog = library.getByRole("dialog", { name: "Edit details" });
  const title = dialog.getByLabel("Title");
  await expect(title).toHaveValue("Known PDF");
  await title.fill("   ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Title cannot be empty.");
  await title.fill("Herbarium Notes");
  await dialog
    .getByLabel("Authors, one per line, in order")
    .fill("Ada Okafor\n\n  Bruno Moreau  ");
  await dialog.getByLabel("Subjects, one per line").fill("Botany\nbotany");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(library.getByRole("status")).toHaveText(
    "Saved details for Herbarium Notes.",
  );
  const card = library
    .getByRole("listitem")
    .filter({ hasText: "Herbarium Notes" });
  await expect(card.locator(".authors")).toHaveText("Ada Okafor, Bruno Moreau");
  expect(book(profile, "Herbarium Notes")).toMatchObject({
    titleManual: 1,
    authorsManual: 1,
    subjectsManual: 1,
  });
  expect(
    catalog(profile, (database) =>
      database
        .prepare(
          "SELECT label FROM book_subjects WHERE book_id = (SELECT id FROM books WHERE title = 'Herbarium Notes')",
        )
        .all()
        .map((row) => row.label),
    ),
  ).toEqual(["Botany"]);

  // Editing only the subjects of the other book leaves its other fields
  // extracted; reopening and cancelling sends nothing.
  await library.getByRole("button", { name: "Clear selection" }).click();
  await select(library, "Reflowable EPUB");
  await bar(library).getByRole("button", { name: "Edit details" }).click();
  await dialog.getByLabel("Subjects, one per line").fill("Poetry");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(book(profile, "Reflowable EPUB")).toMatchObject({
    titleManual: 0,
    authorsManual: 0,
    subjectsManual: 1,
  });
  await bar(library).getByRole("button", { name: "Edit details" }).click();
  await dialog.getByLabel("Title").fill("Not saved");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(book(profile, "Reflowable EPUB")).toMatchObject({ titleManual: 0 });
  await expect(library.getByText("Not saved")).toHaveCount(0);
});
