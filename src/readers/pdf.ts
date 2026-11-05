import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  TextLayer,
  Util,
} from "pdfjs-dist";
import { externalLink } from "../shared/links";
import {
  type ContentsItem,
  panPosition,
  type ReaderLocation,
  type ReaderSession,
  type ReaderSizing,
  restorePan,
  type SearchHit,
} from "./session";
import { literalMatches, textMatches } from "./text";

export class PdfSession extends EventTarget implements ReaderSession {
  readonly format = "pdf";
  readonly reflowable = false;
  sizing: ReaderSizing = { fontSize: 18, zoom: 1 };
  contents: ContentsItem[] = [];
  get visibleText() {
    return (
      this.surface?.querySelector<HTMLElement>('[data-testid="page-text"]')
        ?.textContent ?? ""
    );
  }
  private task?: PDFDocumentLoadingTask;
  private document?: PDFDocumentProxy;
  private surface?: HTMLElement;
  private page = 1;
  private textLayer?: TextLayer;
  private selectedHit?: SearchHit;
  private rendering = Promise.resolve();
  private disposed = false;
  get label() {
    return `Page ${this.page} of ${this.document?.numPages ?? 0}`;
  }

  async open(file: File, surface: HTMLElement) {
    this.surface = surface;
    surface.classList.add("pdf-surface");
    GlobalWorkerOptions.workerSrc =
      "/reader-assets/pdf/build/pdf.worker.min.mjs";
    this.task = getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: "/reader-assets/pdf/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/reader-assets/pdf/standard_fonts/",
      wasmUrl: "/reader-assets/pdf/wasm/",
      useWasm: false,
      useSystemFonts: false,
    });
    this.document = await this.task.promise;
    const outline = await this.document.getOutline();
    const visit = async (items: NonNullable<typeof outline>, prefix = "") => {
      for (const item of items) {
        const page = await this.destinationPage(item.dest);
        if (page)
          this.contents.push({
            label: prefix + item.title,
            target: { format: "pdf", page, x: 0, y: 0 },
          });
        await visit(item.items, `${prefix}— `);
      }
    };
    if (outline) await visit(outline);
    await this.draw();
  }
  private async destinationPage(destination: unknown): Promise<number | null> {
    const doc = this.document;
    if (!doc) return null;
    const dest =
      typeof destination === "string"
        ? await doc.getDestination(destination)
        : destination;
    if (!Array.isArray(dest) || dest.length === 0) return null;
    const index =
      typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
    return index + 1;
  }
  private draw() {
    this.rendering = this.rendering.then(async () => {
      if (this.disposed || !this.document || !this.surface) return;
      const surface = this.surface;
      const pan = panPosition(surface);
      const page = await this.document.getPage(this.page);
      const natural = page.getViewport({ scale: 1 });
      // Fit to the surface's outer box: its client area shrinks when the
      // zoomed page brings scrollbars, which would otherwise change the fit,
      // remove the scrollbars and redraw again in a loop.
      const fit = Math.min(
        surface.offsetWidth / natural.width,
        surface.offsetHeight / natural.height,
      );
      const viewport = page.getViewport({ scale: fit * this.sizing.zoom });
      const box = document.createElement("div");
      box.className = "pdf-page";
      box.style.width = `${viewport.width}px`;
      box.style.height = `${viewport.height}px`;
      box.style.setProperty("--scale-factor", String(viewport.scale));
      box.style.setProperty("--total-scale-factor", String(viewport.scale));
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      box.append(canvas);
      this.textLayer?.cancel();
      surface.replaceChildren(box);
      await page.render({ canvas, viewport }).promise;
      const text = await page.getTextContent();
      const layer = document.createElement("div");
      layer.className = "textLayer";
      box.append(layer);
      this.textLayer = new TextLayer({
        textContentSource: text,
        container: layer,
        viewport,
      });
      await this.textLayer.render();
      const transcript = document.createElement("p");
      transcript.className = "sr-only";
      transcript.dataset.testid = "page-text";
      transcript.textContent =
        text.items.map((item) => ("str" in item ? item.str : "")).join(" ") ||
        "No text on this page";
      box.append(transcript);
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype !== "Link") continue;
        const href = externalLink(annotation.url);
        const target = annotation.dest
          ? await this.destinationPage(annotation.dest)
          : null;
        if (!target && !href) continue;
        const link = document.createElement("button");
        link.className = "pdf-link";
        link.setAttribute(
          "aria-label",
          href ? `External link: ${href}` : `Go to page ${target}`,
        );
        const first = new Float32Array(annotation.rect.slice(0, 2));
        const second = new Float32Array(annotation.rect.slice(2, 4));
        Util.applyTransform(first, viewport.transform);
        Util.applyTransform(second, viewport.transform);
        const [x1 = 0, y1 = 0] = first;
        const [x2 = 0, y2 = 0] = second;
        Object.assign(link.style, {
          left: `${Math.min(x1, x2)}px`,
          top: `${Math.min(y1, y2)}px`,
          width: `${Math.abs(x2 - x1)}px`,
          height: `${Math.abs(y2 - y1)}px`,
        });
        link.onclick = () => {
          if (href)
            this.dispatchEvent(
              new CustomEvent("external-link", { detail: href }),
            );
          else if (target)
            this.dispatchEvent(
              new CustomEvent<ReaderLocation>("navigate", {
                detail: { format: "pdf", page: target, x: 0, y: 0 },
              }),
            );
        };
        box.append(link);
      }
      restorePan(surface, pan);
      this.highlightCurrentHit();
      this.dispatchEvent(new Event("relocate"));
    });
    // A failed page must not permanently poison the draw queue.
    const result = this.rendering;
    this.rendering = result.catch(() => {});
    return result;
  }
  async turn(direction: -1 | 1) {
    await this.jump(
      String(
        Math.max(
          1,
          Math.min(this.document?.numPages ?? 1, this.page + direction),
        ),
      ),
    );
  }
  async jump(value: string) {
    if (
      !/^\d+$/.test(value) ||
      Number(value) < 1 ||
      Number(value) > (this.document?.numPages ?? 0)
    )
      throw new Error(
        `Enter a physical page from 1–${this.document?.numPages ?? 0}.`,
      );
    this.clearSearch();
    this.page = Number(value);
    if (this.surface) restorePan(this.surface, { x: 0, y: 0 });
    await this.draw();
  }
  capture(): ReaderLocation {
    return {
      format: "pdf",
      page: this.page,
      ...(this.surface ? panPosition(this.surface) : { x: 0, y: 0 }),
    };
  }
  async restore(location: ReaderLocation) {
    if (location.format !== "pdf") throw new Error("Location format mismatch.");
    const valid = location.page <= (this.document?.numPages ?? 0);
    await this.jump(String(valid ? location.page : 1));
    if (this.surface && valid) restorePan(this.surface, location);
    return valid ? ("exact" as const) : ("beginning" as const);
  }
  async setSizing(sizing: ReaderSizing) {
    this.sizing = { ...sizing };
    await this.draw();
  }
  async resize() {
    await this.draw();
  }
  async *search(query: string, signal: AbortSignal) {
    for (let page = 1; page <= (this.document?.numPages ?? 0); page++) {
      if (signal.aborted || !this.document) return;
      const content = await (
        await this.document.getPage(page)
      ).getTextContent();
      if (signal.aborted) return;
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      const hits: SearchHit[] = [];
      for (const { excerpt } of literalMatches(text, query)) {
        hits.push({
          location: { format: "pdf", page, x: 0, y: 0 },
          label: `Page ${page}`,
          excerpt,
          query,
          occurrence: hits.length,
        });
      }
      yield { hasText: !!text.trim(), hits };
    }
  }
  async showHit(hit: SearchHit) {
    await this.restore(hit.location);
    this.selectedHit = hit;
    this.highlightCurrentHit(true);
  }
  private highlightCurrentHit(scroll = false) {
    const hit = this.selectedHit;
    if (!hit) return;
    const layer = this.surface?.querySelector(".textLayer");
    const match = layer
      ? [...textMatches(document, layer, hit.query)][hit.occurrence ?? 0]
      : undefined;
    if (match) {
      CSS.highlights.set("reader-search", new Highlight(match.range));
      if (scroll)
        match.range.startContainer.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
    }
  }
  clearSearch() {
    this.selectedHit = undefined;
    CSS.highlights.delete("reader-search");
  }
  async dispose() {
    this.disposed = true;
    await this.rendering;
    this.textLayer?.cancel();
    this.clearSearch();
    const task = this.task;
    this.task = undefined;
    this.document = undefined;
    await task?.destroy();
  }
}
