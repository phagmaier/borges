import { externalLink } from "../shared/links";
import {
  type ContentsItem,
  panPosition,
  ReaderInputError,
  type ReaderLocation,
  type ReaderSession,
  type ReaderSizing,
  restorePan,
  type SearchHit,
} from "./session";
import { textMatches } from "./text";

interface Toc {
  label: string;
  href: string;
  subitems?: Toc[];
}
interface Navigation {
  index: number;
  anchor?: number | ((doc: Document) => Range | Element);
}
const settled = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

// The unstable upstream API stays in this adapter. Runtime modules are copied
// verbatim from the pinned submodule, with notices, by the build configuration.
interface Book {
  transformTarget: EventTarget;
  rendition: { layout?: string; spread?: string };
  sections: { id: string; createDocument(): Promise<Document> }[];
  toc?: Toc[];
  resolveHref(href: string): Navigation | null;
  destroy(): void;
}
interface View extends HTMLElement {
  renderer: HTMLElement & {
    goTo(target: Navigation): Promise<void>;
    setStyles(styles: string): void;
    getContents(): { doc: Document }[];
  };
  lastLocation?: {
    cfi: string;
    range?: Range;
    section: { current: number };
    fraction: number;
  };
  isFixedLayout: boolean;
  resolveCFI(cfi: string): Navigation;
  getCFI(index: number, range?: Range): string;
  getSectionFractions(): number[];
  goTo(target: string | number): Promise<Navigation | undefined>;
  goToFraction(fraction: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  select(cfi: string): Promise<void>;
  deselect(): void;
  open(book: Book): Promise<void>;
  init(options: { showTextStart: boolean }): Promise<void>;
  close(): void;
}
interface Entry {
  filename: string;
  uncompressedSize: number;
  getData(writer: unknown): Promise<unknown>;
}
const moduleAt = (name: string) =>
  import(/* @vite-ignore */ `/reader-assets/foliate/${name}.js`);

function protectDocument(doc: Document): Document {
  for (const element of doc.querySelectorAll(
    'script, iframe, object, embed, base, meta[http-equiv], link:not([rel~="stylesheet"])',
  ))
    element.remove();
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      // URL parsing ignores ASCII controls, including embedded tabs/newlines.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Match those controls deliberately at the untrusted-content boundary.
      const value = attribute.value.replace(/[\u0000-\u0020]/g, "");
      if (
        attribute.localName.toLowerCase().startsWith("on") ||
        /^javascript:/i.test(value)
      )
        element.removeAttributeNode(attribute);
    }
  }
  if (doc.contentType !== "image/svg+xml") {
    const meta = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute(
      "content",
      "default-src 'none'; script-src 'none'; style-src blob: 'unsafe-inline'; img-src blob: data:; font-src blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    );
    doc.querySelector("head")?.prepend(meta);
  }
  return doc;
}

/** The pinned parser assumes at least one Dublin Core metadata element.
 * Empty/missing descriptive metadata is valid for our import fallback: supply
 * only an unknown language to the adapter's in-memory package, leaving the
 * original/stored file and catalog metadata untouched. */
function readablePackage(source: string): string {
  const opf = "http://www.idpf.org/2007/opf";
  const dc = "http://purl.org/dc/elements/1.1/";
  if (!source.includes(opf)) return source;
  const doc = new DOMParser().parseFromString(source, "application/xml");
  const root = doc.documentElement;
  if (root.localName !== "package" || root.namespaceURI !== opf) return source;
  let metadata = [...root.children].find(
    (el) => el.localName === "metadata" && el.namespaceURI === opf,
  );
  if (!metadata) {
    metadata = doc.createElementNS(opf, "metadata");
    root.prepend(metadata);
  }
  if ([...metadata.children].some((el) => el.namespaceURI === dc))
    return source;
  const language = doc.createElementNS(dc, "dc:language");
  language.textContent = "und";
  metadata.append(language);
  return new XMLSerializer().serializeToString(doc);
}

export class EpubSession extends EventTarget implements ReaderSession {
  readonly format = "epub";
  sizing: ReaderSizing = { fontSize: 18, zoom: 1 };
  contents: ContentsItem[] = [];
  get reflowable() {
    return !this.view?.isFixedLayout;
  }
  get label() {
    const loc = this.capture();
    return loc.format === "epub"
      ? `Chapter ${loc.section + 1} · ${Math.round(loc.fraction * 100)}%`
      : "";
  }
  get visibleText() {
    if (this.reflowable)
      return this.view?.lastLocation?.range?.toString() ?? "";
    return (
      this.view?.renderer
        .getContents()
        .map(({ doc }) => doc.body?.textContent ?? "")
        .join(" ") ?? ""
    );
  }
  constructor(
    private readonly onKey: (event: KeyboardEvent) => void = () => {},
  ) {
    super();
  }
  private anchorCfi?: string;
  private selectedCfi?: string;
  private book?: Book;
  private archive?: { close(): Promise<void> };
  private view?: View;

  async open(file: File, surface: HTMLElement): Promise<void> {
    const zip = await moduleAt("vendor/zip");
    zip.configure({ useWebWorkers: false });
    const archive = new zip.ZipReader(new zip.BlobReader(file));
    this.archive = archive;
    const entries: Entry[] = await archive.getEntries();
    const map = new Map(entries.map((entry) => [entry.filename, entry]));
    const { EPUB } = await moduleAt("epub");
    this.book = await new EPUB({
      loadText: async (name: string) => {
        const text = await map.get(name)?.getData(new zip.TextWriter());
        return typeof text === "string" ? readablePackage(text) : null;
      },
      loadBlob: (name: string) =>
        map.get(name)?.getData(new zip.BlobWriter()) ?? null,
      getSize: (name: string) => map.get(name)?.uncompressedSize ?? 0,
    }).init();
    const book = this.book;
    if (!book) throw new Error("EPUB could not be opened.");
    book.transformTarget.addEventListener("load", (event) => {
      const detail = (
        event as CustomEvent<{ isScript: boolean; allow: boolean }>
      ).detail;
      if (detail.isScript) detail.allow = false;
    });
    book.transformTarget.addEventListener("data", (event) => {
      const detail = (
        event as CustomEvent<{ type: string; data: string | Promise<string> }>
      ).detail;
      if (
        ["application/xhtml+xml", "text/html", "image/svg+xml"].includes(
          detail.type,
        )
      ) {
        detail.data = Promise.resolve(detail.data).then((data) =>
          new XMLSerializer().serializeToString(
            protectDocument(
              new DOMParser().parseFromString(
                data,
                detail.type as DOMParserSupportedType,
              ),
            ),
          ),
        );
      }
    });
    // Force single-page layout even when a publisher asks for spreads.
    if (book.rendition?.layout === "pre-paginated")
      book.rendition.spread = "none";
    await moduleAt("view");
    this.view = document.createElement("foliate-view") as View;
    surface.replaceChildren(this.view);
    this.view.addEventListener("external-link", (event) =>
      event.preventDefault(),
    );
    this.view.addEventListener("link", (event) => {
      event.preventDefault();
      const href = (event as CustomEvent<{ href: string }>).detail.href;
      const resolved = book.resolveHref(href);
      if (resolved && book.sections[resolved.index])
        this.dispatchEvent(
          new CustomEvent<ReaderLocation>("navigate", {
            detail: {
              format: "epub",
              cfi: href,
              section: resolved.index,
              fraction: 0,
              x: 0,
              y: 0,
            },
          }),
        );
    });
    this.view.addEventListener("load", (event) => {
      const { doc } = (event as CustomEvent<{ doc: Document }>).detail;
      doc.addEventListener("keydown", this.onKey);
      doc.addEventListener(
        "click",
        (event) => {
          const anchor = (event.target as Element | null)?.closest("a");
          const href =
            anchor?.getAttribute("href") ??
            anchor?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (!href || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href.trim()))
            return;
          // Catch protocol-relative URLs as well as ordinary absolute links,
          // before the upstream reader can interpret them as book navigation.
          event.preventDefault();
          event.stopImmediatePropagation();
          const link = externalLink(href);
          if (link)
            this.dispatchEvent(
              new CustomEvent("external-link", { detail: link }),
            );
        },
        { capture: true },
      );
      if (this.view?.isFixedLayout)
        doc.addEventListener(
          "wheel",
          (event) => {
            event.preventDefault();
            this.view?.renderer.scrollBy(event.deltaX, event.deltaY);
          },
          { passive: false },
        );
    });
    this.view.addEventListener("relocate", () =>
      this.dispatchEvent(new Event("relocate")),
    );
    await this.view.open(book);
    this.view.renderer.setAttribute("max-column-count", "1");
    this.view.renderer.addEventListener("relocate", (event) => {
      const reason = (event as CustomEvent<{ reason: string }>).detail.reason;
      if (["page", "snap", "scroll"].includes(reason))
        this.anchorCfi = undefined;
    });
    if (this.view.isFixedLayout)
      Object.assign(this.view.renderer.style, {
        justifyContent: "safe center",
        alignItems: "safe center",
      });
    await this.view.init({ showTextStart: true });
    if (this.reflowable)
      this.view.renderer.setStyles(
        `body { font-size: ${this.sizing.fontSize}px !important; }`,
      );
    const visit = (items: Toc[], prefix = "") => {
      for (const item of items) {
        const resolved = book.resolveHref(item.href);
        if (resolved)
          this.contents.push({
            label: prefix + item.label,
            target: {
              format: "epub",
              cfi: item.href,
              section: resolved.index,
              fraction: 0,
              x: 0,
              y: 0,
            },
          });
        visit(item.subitems ?? [], `${prefix}— `);
      }
    };
    visit(book.toc ?? []);
    await settled();
  }

  async turn(direction: -1 | 1) {
    this.clearSearch();
    this.anchorCfi = undefined;
    if (direction > 0) await this.view?.next();
    else await this.view?.prev();
  }
  async jump(value: string) {
    if (
      !/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value) ||
      Number(value.slice(0, -1)) > 100
    )
      throw new ReaderInputError(
        "Enter an EPUB percentage from 0–100%, for example 50%.",
      );
    this.clearSearch();
    this.anchorCfi = undefined;
    await this.view?.goToFraction(Number(value.slice(0, -1)) / 100);
  }
  capture(): ReaderLocation {
    const loc = this.view?.lastLocation;
    return {
      format: "epub",
      cfi: this.anchorCfi ?? loc?.cfi ?? "",
      section: loc?.section.current ?? 0,
      fraction: Math.min(1, Math.max(0, loc?.fraction ?? 0)),
      ...(this.view?.isFixedLayout
        ? panPosition(this.view.renderer)
        : { x: 0, y: 0 }),
    };
  }
  async restore(location: ReaderLocation) {
    if (location.format !== "epub" || !this.view || !this.book)
      throw new Error("Location format mismatch.");
    this.clearSearch();
    return this.restoreLocation(location);
  }
  private async restoreLocation(
    location: Extract<ReaderLocation, { format: "epub" }>,
  ) {
    if (!this.view || !this.book) throw new Error("EPUB is not open.");
    try {
      const resolved = location.cfi.startsWith("epubcfi(")
        ? this.view.resolveCFI(location.cfi)
        : this.book.resolveHref(location.cfi);
      if (!resolved || !this.book.sections[resolved.index])
        throw new Error("Invalid chapter.");
      if (typeof resolved.anchor === "function") {
        const doc = await this.chapterDocument(resolved.index);
        if (!doc || !resolved.anchor(doc)) throw new Error("Invalid passage.");
      }
      this.anchorCfi = location.cfi;
      await this.view.renderer.goTo(resolved);
      await settled();
      restorePan(this.view.renderer, location);
      return "exact" as const;
    } catch {
      this.anchorCfi = undefined;
      if (this.book.sections[location.section]) {
        const fractions = this.view.getSectionFractions();
        const start = fractions[location.section] ?? 0;
        const end = fractions[location.section + 1] ?? 1;
        const fraction = Math.max(
          0,
          Math.min(
            1,
            (location.fraction - start) / Math.max(Number.EPSILON, end - start),
          ),
        );
        await this.view.renderer.goTo({
          index: location.section,
          anchor: fraction,
        });
        return "approximate" as const;
      }
      await this.view.goToFraction(location.fraction);
      return "approximate" as const;
    }
  }
  async setSizing(sizing: ReaderSizing) {
    const location = this.capture();
    this.sizing = { ...sizing };
    if (this.reflowable) {
      this.view?.renderer.setStyles(
        `body { font-size: ${sizing.fontSize}px !important; }`,
      );
      await Promise.all(
        this.view?.renderer.getContents().map(({ doc }) => doc.fonts.ready) ??
          [],
      );
      await settled();
      if (location.format === "epub") await this.restoreLocation(location);
      await this.selectCurrentHit();
    } else {
      this.view?.renderer.setAttribute(
        "zoom",
        sizing.zoom === 1 ? "fit-page" : String(sizing.zoom),
      );
      await settled();
    }
  }
  async resize() {
    const location = this.capture();
    if (this.reflowable && this.anchorCfi && location.format === "epub") {
      await this.restoreLocation(location);
      await this.selectCurrentHit();
    } else await settled();
  }
  // Search and locator validation must use the same element structure as the
  // displayed, sanitized chapter. Removing active nodes shifts CFI offsets.
  private async chapterDocument(index: number) {
    const doc = await this.book?.sections[index]?.createDocument();
    return doc ? protectDocument(doc) : undefined;
  }
  async *search(query: string, signal: AbortSignal) {
    if (!this.book || !this.view) return;
    for (let index = 0; index < this.book.sections.length; index++) {
      if (signal.aborted) return;
      const doc = await this.chapterDocument(index);
      if (!doc || signal.aborted) return;
      const hits: SearchHit[] = [];
      for (const { range, excerpt } of textMatches(
        doc,
        doc.body ?? doc.documentElement,
        query,
      )) {
        hits.push({
          location: {
            format: "epub",
            cfi: this.view.getCFI(index, range),
            section: index,
            fraction: 0,
            x: 0,
            y: 0,
          },
          label: `Chapter ${index + 1}`,
          excerpt,
          query,
        });
      }
      yield {
        hasText: !!(doc.body ?? doc.documentElement).textContent?.trim(),
        hits,
      };
    }
  }
  async showHit(hit: SearchHit) {
    if (hit.location.format !== "epub") return;
    await this.restore(hit.location);
    this.selectedCfi = hit.location.cfi;
    await this.selectCurrentHit();
  }
  private async selectCurrentHit() {
    const cfi = this.selectedCfi;
    if (!cfi) return;
    await this.view?.select(cfi);
    // Closing/changing search during asynchronous repagination cancels selection.
    if (this.selectedCfi !== cfi) this.view?.deselect();
  }
  clearSearch() {
    this.selectedCfi = undefined;
    this.view?.deselect();
  }

  async dispose(): Promise<void> {
    const view = this.view;
    const book = this.book;
    const archive = this.archive;
    this.archive = undefined;
    this.view = undefined;
    this.book = undefined;
    try {
      view?.close();
      view?.remove();
      book?.destroy();
    } finally {
      await archive?.close();
    }
  }
}
