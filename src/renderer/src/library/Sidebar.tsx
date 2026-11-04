import type { SectionNode } from "../../../shared/runtime";
import { NewRootSection } from "./SectionActions";
import {
  archiveDestinations,
  type Destination,
  fixedDestinations,
  sameDestination,
} from "./views";

interface SidebarProps {
  selected: Destination;
  sections: SectionNode[] | null;
  onSelect(destination: Destination): void;
  onSectionCreated(id: string): void;
}

const bookCount = (count: number) =>
  `${count} ${count === 1 ? "book" : "books"}`;

function Destinations({
  entries,
  selected,
  onSelect,
}: {
  entries: { destination: Destination; label: string }[];
  selected: Destination;
  onSelect(destination: Destination): void;
}) {
  return (
    <ul className="destinations">
      {entries.map(({ destination, label }) => (
        <li key={label}>
          <button
            type="button"
            aria-current={
              sameDestination(destination, selected) ? "page" : undefined
            }
            onClick={() => onSelect(destination)}
          >
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SectionTree({
  sections,
  selected,
  onSelect,
}: {
  sections: SectionNode[];
  selected: Destination;
  onSelect(destination: Destination): void;
}) {
  return (
    <ul className="section-tree">
      {sections.map((section) => {
        const destination: Destination = {
          kind: "section",
          sectionId: section.id,
        };
        const countId = `section-count-${section.id}`;
        return (
          <li key={section.id}>
            <button
              type="button"
              aria-current={
                sameDestination(destination, selected) ? "page" : undefined
              }
              aria-describedby={countId}
              onClick={() => onSelect(destination)}
            >
              <span className="section-name">{section.name}</span>
              <span className="count" aria-hidden="true">
                {section.bookCount}
              </span>
            </button>
            <span id={countId} hidden>
              {bookCount(section.bookCount)}
            </span>
            {section.children.length > 0 ? (
              <SectionTree
                sections={section.children}
                selected={selected}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Library destinations: fixed views, the nested section tree, Archive, Trash. */
export function Sidebar({
  selected,
  sections,
  onSelect,
  onSectionCreated,
}: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Library">
      <p className="brand">Borges</p>
      <Destinations
        entries={fixedDestinations}
        selected={selected}
        onSelect={onSelect}
      />
      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading">Sections</h2>
        {sections === null ? (
          <p className="quiet">Loading sections…</p>
        ) : sections.length === 0 ? (
          <p className="quiet">No sections yet.</p>
        ) : (
          <SectionTree
            sections={sections}
            selected={selected}
            onSelect={onSelect}
          />
        )}
        <NewRootSection onCreated={onSectionCreated} />
      </section>
      <Destinations
        entries={archiveDestinations}
        selected={selected}
        onSelect={onSelect}
      />
    </nav>
  );
}
