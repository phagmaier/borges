import type { ElectronApplication, Page } from "@playwright/test";
import { catalog, value } from "./catalog";
import { expect, test } from "./desktop";

// Section management and memberships through the library window (A2 through
// the interface). Expected trees, counts and lists follow from the actions
// taken and the spec's section rules; the catalog is checked directly.

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
      { fixture: "fixed.epub", name: "Fixed EPUB.epub" },
    ],
  },
});

const sidebar = (library: Page) =>
  library.getByRole("navigation", { name: "Library" });
const destination = (library: Page, name: string) =>
  sidebar(library).getByRole("button", { name, exact: true });
const heading = (library: Page) => library.getByRole("heading", { level: 1 });

async function libraryWindow(application: ElectronApplication) {
  const library = await application.firstWindow();
  await expect(sidebar(library)).toBeVisible();
  await expect(library.locator(".result-count")).toHaveText("3 books");
  return library;
}

/** The section tree as nested names, from the service. */
async function tree(library: Page) {
  type Node = { name: string; children: Node[] };
  const sections = await value<Node[]>(library, "sections");
  const names = (nodes: Node[]): unknown[] =>
    nodes.map((node) =>
      node.children.length ? [node.name, names(node.children)] : node.name,
    );
  return names(sections);
}

async function shown(library: Page) {
  await expect(library.locator(".result-count")).not.toHaveText("Loading…");
  return library
    .getByRole("list", { name: "Books" })
    .locator(".title")
    .allTextContents();
}

async function selectBooks(library: Page, ...titles: string[]) {
  for (const title of titles)
    await library.getByRole("checkbox", { name: `Select ${title}` }).check();
}

test("create, nest, rename and move sections from the library window", async ({
  application,
}) => {
  const library = await libraryWindow(application);
  await sidebar(library).getByRole("button", { name: "New section" }).click();
  const name = library.getByLabel("New section name");
  await expect(name).toBeFocused();
  await name.fill("  Fiction ");
  await name.press("Enter");
  // The new section is created (trimmed) and shown.
  await expect(heading(library)).toHaveText("Fiction");
  await expect(destination(library, "Fiction")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // A case-insensitive sibling clash is explained and keeps the input.
  await sidebar(library).getByRole("button", { name: "New section" }).click();
  await library.getByLabel("New section name").fill("FICTION");
  await library.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sidebar(library).getByRole("alert")).toHaveText(
    "Another top-level section is already named “Fiction”.",
  );
  await expect(library.getByLabel("New section name")).toHaveValue("FICTION");
  await library.getByLabel("New section name").press("Escape");
  await expect(library.getByLabel("New section name")).toHaveCount(0);

  // A subsection of the selected section.
  await library.getByRole("button", { name: "New subsection" }).click();
  await library.getByLabel("New subsection of Fiction").fill("Verse");
  await library.getByRole("button", { name: "Create", exact: true }).click();
  await expect(heading(library)).toHaveText("Verse");
  expect(await tree(library)).toEqual([["Fiction", ["Verse"]]]);

  // Rename, then move to the top level.
  await library.getByRole("button", { name: "Rename section" }).click();
  const rename = library.getByLabel("Section name");
  await expect(rename).toHaveValue("Verse");
  await rename.fill("Poems");
  await library.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(heading(library)).toHaveText("Poems");
  await library.getByRole("button", { name: "Move section" }).click();
  const into = library.getByLabel("Move Poems into");
  await expect(into.getByRole("option")).toHaveText(["Top level", "Fiction"]);
  await expect(into).toHaveValue(
    (await value<{ id: string }[]>(library, "sections"))[0]?.id ?? "",
  );
  await into.selectOption("Top level");
  await library.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(() => tree(library)).toEqual(["Fiction", "Poems"]);

  // A section's own branch is never offered as a destination.
  await destination(library, "Fiction").click();
  await library.getByRole("button", { name: "Move section" }).click();
  await expect(
    library.getByLabel("Move Fiction into").getByRole("option"),
  ).toHaveText(["Top level", "Poems"]);
  await library.getByLabel("Move Fiction into").selectOption("Poems");
  await library.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(() => tree(library)).toEqual([["Poems", ["Fiction"]]]);
  await destination(library, "Poems").click();
  await library.getByRole("button", { name: "Move section" }).click();
  await expect(
    library.getByLabel("Move Poems into").getByRole("option"),
  ).toHaveText(["Top level"]);
});

test("memberships through selection, and branch deletion with its counts (A2)", async ({
  application,
  profile,
}) => {
  const library = await libraryWindow(application);
  const fiction = await value<{ id: string }>(
    library,
    "createSection",
    "Fiction",
    null,
  );
  await value(library, "createSection", "Verse", fiction.id);

  // Add two books to the child and one of them to the parent too.
  await selectBooks(library, "Known PDF", "Reflowable EPUB");
  const bar = library.getByRole("region", { name: "Selected books" });
  await expect(bar).toContainText("2 books selected");
  await bar.getByLabel("Section to add to").selectOption("Fiction / Verse");
  await bar.getByRole("button", { name: "Add to section" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Added 2 books to Fiction / Verse.",
  );
  await bar.getByRole("button", { name: "Clear selection" }).click();
  await expect(bar).toHaveCount(0);
  await selectBooks(library, "Known PDF");
  await bar.getByLabel("Section to add to").selectOption("Fiction");
  await bar.getByRole("button", { name: "Add to section" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Added 1 book to Fiction.",
  );
  // Each book is counted and listed once in the parent.
  await expect(destination(library, "Fiction")).toHaveAccessibleDescription(
    "2 books",
  );
  await expect(destination(library, "Verse")).toHaveAccessibleDescription(
    "2 books",
  );
  await destination(library, "Fiction").click();
  await expect
    .poll(() => shown(library))
    .toEqual(["Known PDF", "Reflowable EPUB"]);

  // Removing a direct membership keeps the book and its other memberships.
  await destination(library, "Verse").click();
  await selectBooks(library, "Reflowable EPUB");
  await bar.getByRole("button", { name: "Remove from Verse" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Removed 1 book from Verse.",
  );
  await expect.poll(() => shown(library)).toEqual(["Known PDF"]);
  await expect(bar).toHaveCount(0); // The removed book left the view.
  await destination(library, "Unfiled").click();
  await expect
    .poll(() => shown(library))
    .toEqual(["Fixed EPUB", "Reflowable EPUB"]);
  // In the parent, the PDF stays listed through Verse after its direct
  // membership is removed; a second removal explains why nothing changed.
  await destination(library, "Fiction").click();
  await selectBooks(library, "Known PDF");
  await bar.getByRole("button", { name: "Remove from Fiction" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Removed 1 book from Fiction.",
  );
  await expect.poll(() => shown(library)).toEqual(["Known PDF"]);
  await bar.getByRole("button", { name: "Remove from Fiction" }).click();
  await expect(library.getByRole("status")).toHaveText(
    "Removed 0 books from Fiction. Books listed through a subsection keep that membership.",
  );

  // Deleting the branch: the confirmation states the effect; Cancel keeps it.
  await library.getByRole("button", { name: "Delete section" }).click();
  const dialog = library.getByRole("dialog", { name: "Delete Fiction?" });
  await expect(dialog).toHaveText(
    /This also deletes 1 subsection\. 1 book will lose its membership here; 1 book will become Unfiled\. No book is deleted\./,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await tree(library)).toEqual([["Fiction", ["Verse"]]]);
  await library.getByRole("button", { name: "Delete section" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(heading(library)).toHaveText("All Books");
  await expect(sidebar(library).getByText("No sections yet.")).toBeVisible();
  await destination(library, "Unfiled").click();
  await expect
    .poll(() => shown(library))
    .toEqual(["Fixed EPUB", "Known PDF", "Reflowable EPUB"]);
  expect(
    catalog(profile, (database) => ({
      books: database.prepare("SELECT count(*) AS n FROM books").get()?.n,
      sections: database.prepare("SELECT count(*) AS n FROM sections").get()?.n,
      memberships: database
        .prepare("SELECT count(*) AS n FROM section_memberships")
        .get()?.n,
    })),
  ).toEqual({ books: 3, sections: 0, memberships: 0 });
});
