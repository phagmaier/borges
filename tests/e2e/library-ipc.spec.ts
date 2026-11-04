import type { Page } from "@playwright/test";
import {
  acknowledged,
  call,
  catalog,
  openCatalogReader,
  stored,
  value,
} from "./catalog";
import { expect, test } from "./desktop";

// Library-window requests through the real preload bridge and main process
// against a seeded catalog. Expected values follow from the seeded fixture
// names and the spec's section/status/metadata rules, and the catalog is
// checked directly where it matters.

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

const titles = async (page: Page, query?: object) =>
  (await value<{ title: string }[]>(page, "books", query)).map(
    (book) => book.title,
  );

test("sections, memberships, status and metadata through library IPC", async ({
  application,
  profile,
  seeded,
}) => {
  const pdf = seeded["Known PDF"] as string;
  const epub = seeded["Reflowable EPUB"] as string;
  const library = await application.firstWindow();
  await expect(library.getByTestId("library-id")).toHaveText(/./);
  // Count change notifications the library window receives.
  await library.evaluate(() => {
    Reflect.set(window, "changes", 0);
    window.borges.library.onChanged(() =>
      Reflect.set(
        window,
        "changes",
        Number(Reflect.get(window, "changes")) + 1,
      ),
    );
  });
  const changes = () =>
    library.evaluate(() => Number(Reflect.get(window, "changes")));

  // Metadata: ordered authors, subjects deduplicated ignoring case.
  expect(
    await value(library, "editMetadata", pdf, {
      authors: ["Ada Okafor", "Bruno Moreau"],
      subjects: ["Poetry", "poetry", "History"],
    }),
  ).toMatchObject({
    title: "Known PDF",
    authors: ["Ada Okafor", "Bruno Moreau"],
    subjects: ["History", "Poetry"], // A set, listed in name order.
  });
  expect(
    await call(library, "editMetadata", pdf, { title: "  " }),
  ).toMatchObject({ ok: false, code: "invalid" });
  expect(
    await call(library, "editMetadata", "no-such-book", { title: "X" }),
  ).toMatchObject({ ok: false, code: "unknown-book" });
  expect(
    await value(library, "filterTerms", { view: { kind: "all" } }),
  ).toEqual({
    authors: [
      { name: "Ada Okafor", count: 1 },
      { name: "Bruno Moreau", count: 1 },
    ],
    subjects: [
      { name: "History", count: 1 },
      { name: "Poetry", count: 1 },
    ],
  });
  expect(
    await titles(library, { view: { kind: "all" }, author: "ada okafor" }),
  ).toEqual(["Known PDF"]);

  // Sections (A2): one book in a parent and its child is counted once.
  const fiction = await value<{ id: string }>(
    library,
    "createSection",
    "Fiction",
    null,
  );
  const nested = await value<{ id: string }>(
    library,
    "createSection",
    "Nested",
    fiction.id,
  );
  expect(await call(library, "createSection", " fiction ", null)).toMatchObject(
    { ok: false, code: "name-conflict" },
  );
  expect(
    await call(library, "moveSection", fiction.id, nested.id),
  ).toMatchObject({ ok: false, code: "section-cycle" });
  expect(await value(library, "addToSection", nested.id, [pdf, epub])).toEqual({
    added: 2,
  });
  expect(await value(library, "addToSection", fiction.id, [pdf])).toEqual({
    added: 1,
  });
  expect(
    await call(library, "addToSection", fiction.id, [pdf, "no-such-book"]),
  ).toMatchObject({ ok: false, code: "unknown-book" });
  expect(await value(library, "sections")).toEqual([
    {
      id: fiction.id,
      name: "Fiction",
      parentId: null,
      bookCount: 2,
      children: [
        {
          id: nested.id,
          name: "Nested",
          parentId: fiction.id,
          bookCount: 2,
          children: [],
        },
      ],
    },
  ]);
  expect(
    await titles(library, {
      view: { kind: "section", sectionId: fiction.id },
    }),
  ).toEqual(["Known PDF", "Reflowable EPUB"]);
  expect(await titles(library, { view: { kind: "unfiled" } })).toEqual([]);
  expect(
    await value(library, "renameSection", nested.id, "Inner"),
  ).toMatchObject({ name: "Inner" });
  expect(await value(library, "removeFromSection", nested.id, [epub])).toEqual({
    removed: 1,
  });
  expect(await titles(library, { view: { kind: "unfiled" } })).toEqual([
    "Reflowable EPUB",
  ]);
  // Deleting the branch: 2 sections, 1 book (the PDF), which becomes unfiled.
  expect(await value(library, "previewSectionDeletion", fiction.id)).toEqual({
    sections: 2,
    books: 1,
    unfiled: 1,
  });
  expect(await value(library, "deleteSection", fiction.id)).toEqual({
    sections: 2,
    books: 1,
    unfiled: 1,
  });
  expect(await value(library, "sections")).toEqual([]);
  expect(await titles(library, { view: { kind: "unfiled" } })).toEqual([
    "Known PDF",
    "Reflowable EPUB",
  ]);

  // Status and Archive are independent; Archive hides from All Books.
  expect(await value(library, "finish", pdf)).toMatchObject({
    status: "finished",
    archived: false,
  });
  expect(await value(library, "archive", epub)).toMatchObject({
    status: "unread",
    archived: true,
  });
  expect(await titles(library)).toEqual(["Known PDF"]);
  expect(await titles(library, { view: { kind: "archive" } })).toEqual([
    "Reflowable EPUB",
  ]);
  expect(await titles(library, { view: { kind: "finished" } })).toEqual([
    "Known PDF",
  ]);
  expect(await value(library, "unarchive", epub)).toMatchObject({
    archived: false,
  });
  expect(
    catalog(profile, (database) =>
      database
        .prepare(
          "SELECT title, reading_status AS status, archived_at IS NOT NULL AS archived, authors_manual AS authorsManual FROM books ORDER BY title",
        )
        .all()
        .map((row) => ({ ...row })),
    ),
  ).toEqual([
    { title: "Known PDF", status: "finished", archived: 0, authorsManual: 1 },
    {
      title: "Reflowable EPUB",
      status: "unread",
      archived: 0,
      authorsManual: 0,
    },
  ]);
  // Each of the 11 successful changes was announced, and no failure or read:
  // 1 metadata edit, 2 creations, 2 additions, 1 rename, 1 removal,
  // 1 deletion, finish, archive and unarchive.
  await expect.poll(changes).toBe(11);

  // Malformed input is refused by the service, not trusted.
  expect(
    await call(library, "books", { view: { kind: "section" } }),
  ).toMatchObject({ ok: false, code: "invalid" });
  expect(await call(library, "addToSection", fiction.id, "x")).toMatchObject({
    ok: false,
  });

  // A reader window cannot use library requests; nothing changes.
  const { reader } = await openCatalogReader(application, "Known PDF");
  for (const [method, args] of [
    ["books", []],
    ["archive", [pdf]],
    ["createSection", ["From reader", null]],
    ["startRereading", [pdf]],
  ] as const)
    expect(await call(reader, method, ...args)).toMatchObject({
      ok: false,
      thrown: expect.stringContaining("Only the library window may do this."),
    });
  expect(await value(library, "sections")).toEqual([]);
  expect(stored(profile, pdf).status).toBe("finished");
});

test("Start Rereading restarts an open reader at the beginning and stales its old session", async ({
  application,
  profile,
  seeded,
}) => {
  const pdf = seeded["Known PDF"] as string;
  const library = await application.firstWindow();
  await expect(library.getByTestId("library-id")).toHaveText(/./);
  const announced = library.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const stop = window.borges.library.onChanged(() => {
          stop();
          resolve(true);
        });
      }),
  );
  const first = await openCatalogReader(application, "Known PDF");
  await expect(first.ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  // The reader's successful open reaches the library as a change.
  expect(await announced).toBe(true);
  expect(stored(profile, pdf).status).toBe("reading");
  const surface = first.ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  await expect(first.ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await expect.poll(() => stored(profile, pdf).page).toBe(3);
  await acknowledged(first.reader);
  // Finished and archived, but still open for reference.
  await value(first.library, "finish", pdf);
  await value(first.library, "archive", pdf);
  const before = stored(profile, pdf);
  expect(before).toMatchObject({ status: "finished", page: 3 });

  expect(await value(first.library, "startRereading", pdf)).toMatchObject({
    status: "reading",
    archived: false,
  });
  // The same window reloads into a new session at page 1.
  const ui = first.reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await expect(ui.locator("#location")).toHaveText("Page 1 of 3");
  await expect
    .poll(() => stored(profile, pdf))
    .toMatchObject({ page: 1, status: "reading" });
  const after = stored(profile, pdf);
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.revision).toBe(before.revision);
  await expect(first.library.getByTestId(`status-${pdf}`)).toHaveText(
    "Currently Reading",
  );

  // A late write carrying the old page's identity is rejected.
  const result = await first.reader.evaluate(
    (write) =>
      new Promise<string>((resolve) => {
        const stop = window.borges.reader.onProgressResult((outcome) => {
          stop();
          resolve(outcome.ok ? "ok" : outcome.code);
        });
        window.borges.reader.reportProgress(write as never);
      }),
    {
      bookId: pdf,
      revisionId: before.revision,
      generation: before.generation,
      sequence: 999,
      location: { format: "pdf", page: 3, x: 0, y: 0 },
      sizing: { fontSize: 18, zoom: 1 },
    },
  );
  expect(result).toBe("stale-session");
  expect(stored(profile, pdf).page).toBe(1);
  // Exactly one reader window remains for the book.
  expect(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(2);
});
