import type { ElectronApplication, Page } from "@playwright/test";
import { bookButton, stored, value } from "./catalog";
import { expect, test } from "./desktop";

// The library window's browsing UI against a seeded catalog (A3 through the
// interface). Organization is set up through the real library service; the
// expected lists follow from that setup and the spec's view/search rules.

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
      { fixture: "fixed.epub", name: "Fixed EPUB.epub" },
      { fixture: "image-only.pdf", name: "Image-only PDF.pdf" },
    ],
  },
});

/** Titles shown in the results, in order. */
async function shown(library: Page) {
  await expect(library.locator(".result-count")).not.toHaveText("Loading…");
  return library
    .getByRole("list", { name: "Books" })
    .locator(".title")
    .allTextContents()
    .catch(() => []);
}

async function expectShown(library: Page, titles: string[]) {
  await expect
    .poll(async () =>
      (await library.getByRole("list", { name: "Books" }).count()) === 0
        ? []
        : shown(library),
    )
    .toEqual(titles);
}

/** Author/subject filters and Include archived live in the Filters disclosure. */
async function openFilters(library: Page) {
  const panel = library.locator("details.filter-panel");
  if (
    !(await panel.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await panel.locator("summary").click();
}

const sidebar = (library: Page) =>
  library.getByRole("navigation", { name: "Library" });
const destination = (library: Page, name: string) =>
  sidebar(library).getByRole("button", { name, exact: true });

/** Two nested sections, metadata and one archived book. */
async function organize(library: Page, seeded: Record<string, string>) {
  const ids = {
    pdf: seeded["Known PDF"] as string,
    epub: seeded["Reflowable EPUB"] as string,
    fixed: seeded["Fixed EPUB"] as string,
    image: seeded["Image-only PDF"] as string,
  };
  await value(library, "editMetadata", ids.pdf, {
    authors: ["Ada Okafor"],
    subjects: ["Botany"],
  });
  await value(library, "editMetadata", ids.epub, {
    authors: ["Bruno Moreau", "Ada Okafor"],
    subjects: ["Poetry"],
  });
  await value(library, "editMetadata", ids.fixed, {
    authors: ["Clara Tanaka"],
    subjects: ["Botany", "Poetry"],
  });
  const fiction = await value<{ id: string }>(
    library,
    "createSection",
    "Fiction",
    null,
  );
  const verse = await value<{ id: string }>(
    library,
    "createSection",
    "Verse",
    fiction.id,
  );
  await value(library, "addToSection", fiction.id, [ids.pdf]);
  await value(library, "addToSection", verse.id, [ids.pdf, ids.epub]);
  await value(library, "archive", ids.fixed);
  return ids;
}

async function libraryWindow(application: ElectronApplication) {
  const library = await application.firstWindow();
  await expect(sidebar(library)).toBeVisible();
  return library;
}

test("sidebar views, selected-view search, filters and the archive toggle", async ({
  application,
  seeded,
}) => {
  const library = await libraryWindow(application);
  await organize(library, seeded);
  // All Books: archived Fixed EPUB hidden; title order.
  await expectShown(library, [
    "Image-only PDF",
    "Known PDF",
    "Reflowable EPUB",
  ]);
  await expect(library.getByRole("heading", { level: 1 })).toHaveText(
    "All Books",
  );
  await expect(destination(library, "All Books")).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Section tree with unique-book counts: Fiction has the PDF directly and
  // via Verse (counted once) plus the EPUB through Verse.
  const fiction = destination(library, "Fiction");
  await expect(fiction).toHaveAccessibleDescription("2 books");
  await expect(destination(library, "Verse")).toHaveAccessibleDescription(
    "2 books",
  );
  await fiction.click();
  await expect(library.getByRole("heading", { level: 1 })).toHaveText(
    "Fiction",
  );
  await expectShown(library, ["Known PDF", "Reflowable EPUB"]);
  await destination(library, "Unfiled").click();
  await expectShown(library, ["Image-only PDF"]);
  await destination(library, "Archive").click();
  await expectShown(library, ["Fixed EPUB"]);
  await expect(library.getByLabel("Include archived")).toHaveCount(0);
  await destination(library, "Trash").click();
  await expect(library.getByText(/^Trash is empty\./)).toBeVisible();
  await expect(library.getByRole("searchbox")).toHaveCount(0);

  // Search filters the selected view; each term must match some field.
  await destination(library, "All Books").click();
  const search = library.getByRole("searchbox", { name: "Search All Books" });
  await search.fill("okafor");
  await expectShown(library, ["Known PDF", "Reflowable EPUB"]);
  await search.fill("okafor poetry");
  await expectShown(library, ["Reflowable EPUB"]);
  // Botany matches the archived Fixed EPUB only with the toggle on.
  await search.fill("botany");
  await expectShown(library, ["Known PDF"]);
  await openFilters(library);
  await library.getByLabel("Include archived").check();
  await expectShown(library, ["Fixed EPUB", "Known PDF"]);
  await expect(
    library
      .getByRole("listitem")
      .filter({ hasText: "Fixed EPUB" })
      .getByText("· Archived"),
  ).toBeVisible();
  await library.getByLabel("Include archived").uncheck();
  // The search text carries into another view and filters it there.
  await fiction.click();
  await expect(
    library.getByRole("searchbox", { name: "Search Fiction" }),
  ).toHaveValue("botany");
  await expectShown(library, ["Known PDF"]);
  await destination(library, "Archive").click();
  await expectShown(library, ["Fixed EPUB"]);

  // No matches offers clearing; data is not lost.
  await library.getByRole("searchbox").fill("nonexistent");
  await expect(
    library.getByText("No books in Archive match this search."),
  ).toBeVisible();
  await library
    .getByRole("button", { name: "Clear search and filters" })
    .click();
  await expect(library.getByRole("searchbox")).toHaveValue("");
  await expectShown(library, ["Fixed EPUB"]);

  // Author/subject filters list the view's terms with counts.
  await destination(library, "All Books").click();
  await openFilters(library);
  const author = library.getByLabel("Author");
  await expect(author.getByRole("option")).toHaveText([
    "Any author",
    "Ada Okafor (2)",
    "Bruno Moreau (1)",
  ]);
  await author.selectOption("Bruno Moreau");
  await expectShown(library, ["Reflowable EPUB"]);
  await library.getByLabel("Subject").selectOption("Botany");
  await expect(
    library.getByText("No books in All Books match this search."),
  ).toBeVisible();
  // Changing view resets the filters (their choices belong to a view).
  await destination(library, "Unfiled").click();
  await expect(library.getByLabel("Author")).toHaveValue("");
  await expectShown(library, ["Image-only PDF"]);
});

test("keyboard opening, list layout, live status updates and a deleted selected section", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await libraryWindow(application);
  const ids = await organize(library, seeded);
  await expectShown(library, [
    "Image-only PDF",
    "Known PDF",
    "Reflowable EPUB",
  ]);

  // Keyboard: Tab from the search box through the toolbar to the books.
  await openFilters(library);
  await library.getByRole("searchbox").focus();
  const order: string[] = [];
  for (let presses = 0; presses < 10; presses++) {
    await library.keyboard.press("Tab");
    order.push(
      await library.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        // An aria-label, a labelled control's label text, or a title.
        return (
          element?.getAttribute("aria-label") ??
          element?.closest("label")?.querySelector("span")?.textContent ??
          (element?.querySelector(".title") ?? element)?.textContent ??
          ""
        ).trim();
      }),
    );
  }
  expect(order).toEqual([
    "Filters",
    "Author",
    "Subject",
    "Include archived",
    "Grid",
    "List",
    "Image-only PDF",
    "Select Image-only PDF",
    "Known PDF",
    "Select Known PDF",
  ]);
  const button = bookButton(library, "Known PDF");
  await library.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  expect(
    await button.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
  const opened = application.waitForEvent("window");
  await button.press("Enter");
  await library
    .getByRole("dialog", { name: "Edit details" })
    .getByRole("button", { name: "Read book" })
    .click();
  const reader = await opened;
  await expect(
    reader.frameLocator('iframe[title="Book content"]').getByRole("status"),
  ).toHaveText("Ready");
  // The open reaches the library without refocusing it.
  await expect(library.getByTestId(`status-${ids.pdf}`)).toHaveText(
    "Currently Reading",
  );
  expect(stored(profile, ids.pdf).status).toBe("reading");
  await destination(library, "Currently Reading").click();
  await expectShown(library, ["Known PDF"]);

  // Compact list layout with the same open action.
  await destination(library, "All Books").click();
  await library.getByRole("button", { name: "List", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // The Continue reading strip belongs to the cover grid only.
  const strip = library.getByRole("region", { name: "Continue reading" });
  await expect(strip).toHaveCount(0);
  const table = library.getByRole("table", { name: "Books" });
  await expect(table.getByRole("row")).toHaveCount(4); // Header and 3 books.
  await expect(
    table.getByRole("row", { name: /Reflowable EPUB/ }).getByRole("cell"),
  ).toHaveText(["", "Bruno Moreau, Ada Okafor", "Unread", "EPUB"]);
  const second = application.waitForEvent("window");
  await table
    .getByRole("button", { name: "Image-only PDF", exact: true })
    .dblclick();
  await second;
  expect(application.windows()).toHaveLength(3);

  // Continue reading: All Books' Currently Reading books, most recently
  // opened first, while the view is not narrowed; they stay in the results.
  await library.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(strip.locator(".continue-title")).toHaveText([
    "Image-only PDF",
    "Known PDF",
  ]);
  await expect(
    strip.getByRole("button", { name: "Continue Known PDF", exact: true }),
  ).toBeVisible();
  await expectShown(library, [
    "Image-only PDF",
    "Known PDF",
    "Reflowable EPUB",
  ]);
  await library.getByRole("searchbox").fill("known");
  await expectShown(library, ["Known PDF"]);
  await expect(strip).toHaveCount(0);
  await library.getByRole("searchbox").fill("");
  await openFilters(library);
  await library.getByLabel("Include archived").check();
  await expect(library.locator(".filter-panel summary")).toHaveText(
    "Filters (1 active)",
  );
  await library.getByLabel("Include archived").uncheck();
  await expect(library.locator(".filter-panel summary")).toHaveText("Filters");
  await library.getByLabel("Include archived").press("Escape");
  await expect(library.getByLabel("Author")).toBeHidden();
  await expect(library.locator(".filter-panel summary")).toBeFocused();
  await destination(library, "Currently Reading").click();
  await expect(strip).toHaveCount(0);
  await destination(library, "All Books").click();

  // Deleting the selected section returns the window to All Books.
  await library.getByRole("button", { name: "Grid", exact: true }).click();
  await destination(library, "Verse").click();
  await expectShown(library, ["Known PDF", "Reflowable EPUB"]);
  const verse = await library.evaluate(async () => {
    const sections = await window.borges.library.sections();
    return sections.ok ? sections.value[0]?.children[0]?.id : undefined;
  });
  await value(library, "deleteSection", verse);
  await expect(library.getByRole("heading", { level: 1 })).toHaveText(
    "All Books",
  );
  await expect(destination(library, "Verse")).toHaveCount(0);
  await expect(destination(library, "Fiction")).toHaveAccessibleDescription(
    "1 book",
  );
});

test.describe("empty states", () => {
  test.use({
    catalog: { books: [{ fixture: "known.pdf", name: "Known PDF.pdf" }] },
  });

  test("an all-archived library and an empty view explain themselves", async ({
    application,
    seeded,
  }) => {
    const library = await libraryWindow(application);
    await expectShown(library, ["Known PDF"]);
    await expect(library.getByText("No sections yet.")).toBeVisible();
    await destination(library, "Finished").click();
    await expect(
      library.getByText("Books you mark Finished appear here."),
    ).toBeVisible();
    await destination(library, "All Books").click();
    await value(library, "archive", seeded["Known PDF"]);
    await expect(
      library.getByText("Every book in this library is archived."),
    ).toBeVisible();
    await library.getByRole("button", { name: "Show Archive" }).click();
    await expect(library.getByRole("heading", { level: 1 })).toHaveText(
      "Archive",
    );
    await expectShown(library, ["Known PDF"]);
  });
});

test.describe("an empty library", () => {
  test.use({ catalog: { books: [] } });

  test("invites import", async ({ application }) => {
    const library = await libraryWindow(application);
    await expect(
      library.getByText("No books have been added to this library yet."),
    ).toBeVisible();
    await expect(library.locator(".result-count")).toHaveText("0 books");
  });
});

test.describe("a library larger than one batch", () => {
  test.use({
    catalog: {
      books: Array.from({ length: 130 }, (_, i) => ({
        // Distinct bytes per book: identical content would be skipped.
        content: `%PDF-1.7\n% created placeholder ${i}\n`,
        name: `Volume ${i + 1}.pdf`,
      })),
    },
  });

  test("renders 100 books at a time and adds the rest on request or scroll", async ({
    application,
  }) => {
    const library = await libraryWindow(application);
    const items = library
      .getByRole("list", { name: "Books" })
      .getByRole("listitem");
    await expect(library.locator(".result-count")).toHaveText("130 books");
    await expect(items).toHaveCount(100);
    // Numeric title order: Volume 1 … Volume 100 first.
    await expect(items.first().locator(".title")).toHaveText("Volume 1");
    await expect(items.last().locator(".title")).toHaveText("Volume 100");
    // Reaching the last rendered book by keyboard brings the end into view,
    // which loads the next batch; focus stays on that book.
    const last = bookButton(library, "Volume 100");
    await last.focus();
    await expect(items).toHaveCount(130);
    await expect(last).toBeFocused();
    await expect(items.last().locator(".title")).toHaveText("Volume 130");
    await expect(
      library.getByRole("button", { name: /^Show more books/ }),
    ).toHaveCount(0);

    // Another view starts from the first batch again.
    await destination(library, "Unfiled").click();
    await expect(library.locator(".result-count")).toHaveText("130 books");
    await expect(items).toHaveCount(100);
    // Scrolling near the end loads the next batch without the button.
    await library
      .locator(".library-main")
      .evaluate((main) => main.scrollTo(0, main.scrollHeight));
    await expect(items).toHaveCount(130);
  });
});

test("single click edits details in grid and list; double click opens only the reader", async ({
  application,
  seeded,
}) => {
  const library = await libraryWindow(application);
  for (const layout of ["Grid", "List"]) {
    await library.getByRole("button", { name: layout, exact: true }).click();
    const book = library
      .locator(layout === "Grid" ? ".book-grid" : ".book-list")
      .getByRole("button", { name: "Known PDF", exact: true });
    await book.click();
    const details = library.getByRole("dialog", { name: "Edit details" });
    await expect(
      details.getByRole("textbox", { name: "Title", exact: true }),
    ).toHaveValue("Known PDF");
    expect(application.windows()).toHaveLength(1);
    await details
      .getByRole("textbox", { name: "Subjects, one per line" })
      .fill(layout);
    await details.getByRole("button", { name: "Save", exact: true }).click();
    await expect(details).toHaveCount(0);
    const opened = application.waitForEvent("window");
    await book.dblclick();
    const reader = await opened;
    await expect(
      reader.frameLocator('iframe[title="Book content"]').getByRole("status"),
    ).toHaveText("Ready");
    await expect(details).toHaveCount(0);
    const books = await value<{ id: string; subjects: string[] }[]>(
      library,
      "books",
    );
    expect(books.find((b) => b.id === seeded["Known PDF"])?.subjects).toEqual([
      layout,
    ]);
    await reader.close();
  }
});
