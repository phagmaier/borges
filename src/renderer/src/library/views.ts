import type { LibraryView, SectionNode } from "../../../shared/runtime";

/** A sidebar destination: a catalog view, or Trash (arrives in milestone 4). */
export type Destination = LibraryView | { kind: "trash" };

export const fixedDestinations: { destination: Destination; label: string }[] =
  [
    { destination: { kind: "all" }, label: "All Books" },
    { destination: { kind: "reading" }, label: "Currently Reading" },
    { destination: { kind: "finished" }, label: "Finished" },
    { destination: { kind: "unfiled" }, label: "Unfiled" },
  ];
export const archiveDestinations: {
  destination: Destination;
  label: string;
}[] = [
  { destination: { kind: "archive" }, label: "Archive" },
  { destination: { kind: "trash" }, label: "Trash" },
];

export function sameDestination(a: Destination, b: Destination): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "section" || a.sectionId === (b as typeof a).sectionId;
}

export function findSection(
  sections: SectionNode[],
  id: string,
): SectionNode | undefined {
  for (const section of sections) {
    if (section.id === id) return section;
    const found = findSection(section.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Sections in tree order with their full path, for choosing a section. */
export function flattenSections(
  sections: SectionNode[],
  parents: string[] = [],
): { id: string; path: string }[] {
  return sections.flatMap((section) => [
    { id: section.id, path: [...parents, section.name].join(" / ") },
    ...flattenSections(section.children, [...parents, section.name]),
  ]);
}

/** IDs of a section and all of its descendants. */
export function branchIds(section: SectionNode): string[] {
  return [section.id, ...section.children.flatMap(branchIds)];
}

export function destinationTitle(
  destination: Destination,
  sections: SectionNode[],
): string {
  if (destination.kind === "section")
    return findSection(sections, destination.sectionId)?.name ?? "Section";
  return (
    [...fixedDestinations, ...archiveDestinations].find(
      (entry) => entry.destination.kind === destination.kind,
    )?.label ?? ""
  );
}

/** What an empty view says when no search or filter is narrowing it. */
export function emptyViewMessage(destination: Destination): string {
  switch (destination.kind) {
    case "all":
      return "No books have been added to this library yet.";
    case "reading":
      return "Books you start reading appear here.";
    case "finished":
      return "Books you mark Finished appear here.";
    case "unfiled":
      return "Every book belongs to at least one section.";
    case "section":
      return "This section has no books yet.";
    case "archive":
      return "Archived books appear here, out of the way of normal browsing.";
    case "trash":
      return "Trash is empty. Deleted books and replaced files will appear here once deletion is available.";
  }
}

export const statusLabels = {
  unread: "Unread",
  reading: "Currently Reading",
  finished: "Finished",
} as const;
