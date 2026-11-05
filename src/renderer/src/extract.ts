import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { ExtractedBook } from "../../library/extraction";
import type { BookFormat } from "../../library/formats";

// This page has no preload, host bridge or book DOM. XML remains detached;
// images are decoded only after byte/dimension checks. Main destroys this
// separate sandboxed renderer on completion, cancellation, timeout or excess
// working memory, including its PDF worker and all temporary objects.
import { coverDimensions, MAX_COVER_BYTES } from "../../shared/cover-image";

const MiB = 1024 * 1024;
const MAX_ENTRY = 32 * MiB;
const MAX_EXPANDED = 256 * MiB;
const MAX_XML = 8 * MiB;
const OPF = "http://www.idpf.org/2007/opf";
const DC = "http://purl.org/dc/elements/1.1/";
const ENC = "http://www.w3.org/2001/04/xmlenc#";

type Failure = {
  ok: false;
  code: "protected" | "invalid-content" | "resource-limit";
  message: string;
};
class Refusal extends Error {
  constructor(
    readonly code: Failure["code"],
    message: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new Refusal("invalid-content", message);
}
function limit(): never {
  throw new Refusal(
    "resource-limit",
    "Content exceeds the bounded import parser's resource limits.",
  );
}
const empty = (): ExtractedBook => ({
  title: null,
  authors: [],
  subjects: [],
  cover: null,
  warnings: [],
});
const elements = (node: Document | Element, ns: string, name: string) =>
  Array.from(node.getElementsByTagNameNS(ns, name));
const text = (node?: Element) => node?.textContent?.trim() || null;

/** Decode only bounded raster images, never SVG or a book DOM. */
async function thumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  if (!coverDimensions(bytes)) throw new Error("Unusable cover dimensions");
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)]));
  try {
    const scale = Math.min(1, 512 / bitmap.width, 768 / bitmap.height);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No image decoder");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
  } finally {
    bitmap.close();
  }
}

let pendingCover: (() => Promise<Uint8Array | null>) | undefined;
const dispose: (() => Promise<unknown>)[] = [];

async function pdf(bytes: Uint8Array): Promise<ExtractedBook> {
  GlobalWorkerOptions.workerSrc = "/reader-assets/pdf/build/pdf.worker.min.mjs";
  const task = getDocument({
    data: bytes,
    cMapUrl: "/reader-assets/pdf/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/reader-assets/pdf/standard_fonts/",
    wasmUrl: "/reader-assets/pdf/wasm/",
    useWasm: false,
    useSystemFonts: false,
    stopAtErrors: true,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 64 * MiB,
  });
  dispose.push(() => task.destroy());
  // Refuse even an empty-user-password PDF; no unlocking or password UI.
  let encrypted = false;
  task.onPassword = () => {
    encrypted = true;
    void task.destroy();
  };
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    if (
      encrypted ||
      (error instanceof Error &&
        (error.name === "PasswordException" || /password/i.test(error.message)))
    )
      throw new Refusal("protected", "Encrypted PDFs are not supported.");
    throw error;
  }
  try {
    if ((await document.getPermissions()) !== null)
      throw new Refusal("protected", "Encrypted PDFs are not supported.");
    if (document.numPages < 1) invalid("The PDF has no readable pages.");
    if (document.numPages > 10_000) limit();
    // Force page-tree/content parsing, including pages after the first. No
    // text index or rendered page cache is retained for an imported book.
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const ops = await page.getOperatorList();
      if (ops.fnArray.length > 1_000_000) limit();
      page.cleanup();
    }
    const result = empty();
    try {
      const { info, metadata } = await document.getMetadata();
      const data = info as Record<string, unknown>;
      if (data.EncryptFilterName != null)
        throw new Refusal("protected", "Encrypted PDFs are not supported.");
      const creators = metadata?.get("dc:creator");
      const subjects = metadata?.get("dc:subject");
      result.title =
        String(metadata?.get("dc:title") || data.Title || "").trim() || null;
      result.authors = Array.isArray(creators)
        ? creators
        : typeof data.Author === "string"
          ? data.Author.split(/[;\n]/)
          : [];
      result.subjects = Array.isArray(subjects)
        ? subjects
        : [
            data.Subject,
            ...(typeof data.Keywords === "string"
              ? data.Keywords.split(/[,;\n]/)
              : []),
          ].filter((x): x is string => typeof x === "string");
    } catch (error) {
      if (error instanceof Refusal) throw error;
      result.warnings.push(
        "Metadata could not be extracted; filename and empty fields were used.",
      );
    }
    pendingCover = async () => {
      const page = await document.getPage(1);
      const initial = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(512 / initial.width, 768 / initial.height),
      });
      if (
        !Number.isFinite(viewport.width) ||
        viewport.width <= 0 ||
        !Number.isFinite(viewport.height) ||
        viewport.height <= 0
      )
        throw new Error("Invalid page dimensions");
      const canvas = documentCanvas(viewport.width, viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("No thumbnail")),
          "image/png",
        ),
      );
      return new Uint8Array(await blob.arrayBuffer());
    };
    return result;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}
function documentCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

interface ZipEntry {
  filename: string;
  uncompressedSize: number;
  encrypted: boolean;
  directory: boolean;
  getData(writer: unknown, options?: unknown): Promise<Blob>;
}
const moduleAt = (path: string) =>
  import(/* @vite-ignore */ `/reader-assets/foliate/${path}.js`);
function xml(value: string, name: string): Document {
  if (/<!ENTITY/i.test(value))
    invalid(`Unsupported entity declaration in ${name}.`);
  const doc = new DOMParser().parseFromString(value, "application/xml");
  if (doc.querySelector("parsererror"))
    invalid(`Unparseable EPUB XML (${name}).`);
  return doc;
}
function resource(href: string, base = ""): string {
  // Resolve archive-local paths only. Never fetch a URL from the book.
  const url = new URL(href, `https://archive.invalid/${base}`);
  if (url.origin !== "https://archive.invalid" || url.username || url.password)
    invalid("An EPUB package references content outside its archive.");
  return decodeURIComponent(url.pathname.slice(1));
}
async function epub(bytes: Uint8Array): Promise<ExtractedBook> {
  const zip = await moduleAt("vendor/zip");
  zip.configure({ useWebWorkers: false });
  const archive = new zip.ZipReader(
    new zip.BlobReader(new Blob([Uint8Array.from(bytes)])),
  );
  dispose.push(() => archive.close());
  try {
    const entries: ZipEntry[] = await archive.getEntries();
    if (entries.length > 10_000) limit();
    let total = 0;
    const map = new Map<string, ZipEntry>();
    for (const entry of entries) {
      if (entry.encrypted)
        throw new Refusal(
          "protected",
          "Encrypted EPUB archives are not supported.",
        );
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_ENTRY || total > MAX_EXPANDED) limit();
      if (map.has(entry.filename))
        invalid("EPUB contains ambiguous duplicate archive entries.");
      map.set(entry.filename, entry);
    }
    const load = async (name: string, max = MAX_XML): Promise<Uint8Array> => {
      const entry = map.get(name);
      if (!entry || entry.directory) invalid(`Missing EPUB content (${name}).`);
      if (entry.uncompressedSize > max) limit();
      // zip.js enforces the central directory's uncompressed size during
      // inflation (checkOverlappingEntry/checkSignature also reject damage).
      const data = await entry.getData(new zip.BlobWriter(), {
        checkSignature: true,
        checkOverlappingEntry: true,
      });
      if (data.size > max) limit();
      return new Uint8Array(await data.arrayBuffer());
    };
    const loadXML = async (name: string) =>
      xml(new TextDecoder().decode(await load(name)), name);
    const container = await loadXML("META-INF/container.xml");
    const rootfile = elements(
      container,
      "urn:oasis:names:tc:opendocument:xmlns:container",
      "rootfile",
    ).find(
      (el) => el.getAttribute("media-type") === "application/oebps-package+xml",
    );
    const packagePath = rootfile?.getAttribute("full-path");
    if (!packagePath) invalid("The EPUB has no package document.");
    const path = resource(packagePath);
    const opf = await loadXML(path);
    if (
      opf.documentElement.localName !== "package" ||
      opf.documentElement.namespaceURI !== OPF
    )
      invalid("Invalid EPUB package document.");
    const manifest = new Map(
      elements(opf, OPF, "item").map((el) => [el.getAttribute("id"), el]),
    );
    const spine = elements(opf, OPF, "itemref");
    if (!spine.length) invalid("The EPUB has no readable spine.");
    if (map.has("META-INF/encryption.xml")) {
      const encryption = await loadXML("META-INF/encryption.xml");
      for (const encrypted of elements(encryption, ENC, "EncryptedData")) {
        const method = elements(
          encrypted,
          ENC,
          "EncryptionMethod",
        )[0]?.getAttribute("Algorithm");
        const uri = elements(
          encrypted,
          ENC,
          "CipherReference",
        )[0]?.getAttribute("URI");
        const target = uri ? resource(uri) : "";
        const font = [...manifest.values()].find(
          (el) => resource(el.getAttribute("href") || "", path) === target,
        );
        const fontType = font?.getAttribute("media-type") || "";
        if (
          ![
            "http://www.idpf.org/2008/embedding",
            "http://ns.adobe.com/pdf/enc#RC",
          ].includes(method || "") ||
          !/^(font\/|application\/(vnd\.ms-opentype|x-font-|font-))/.test(
            fontType,
          )
        )
          throw new Refusal(
            "protected",
            "DRM-protected EPUB content is not supported (only font obfuscation is allowed).",
          );
      }
    }
    for (const reference of spine) {
      const item = manifest.get(reference.getAttribute("idref"));
      const href = item?.getAttribute("href");
      if (!href) invalid("The EPUB spine references a missing manifest item.");
      const mediaType = item?.getAttribute("media-type");
      if (
        !["application/xhtml+xml", "text/html", "image/svg+xml"].includes(
          mediaType || "",
        )
      )
        invalid("The EPUB has an unsupported spine media type.");
      const name = resource(href, path);
      const doc = await loadXML(name);
      if (!["html", "svg"].includes(doc.documentElement.localName))
        invalid(`Unparseable EPUB spine content (${name}).`);
    }
    const result = empty();
    try {
      const titles = elements(opf, DC, "title");
      const main = elements(opf, OPF, "meta")
        .find(
          (el) =>
            el.getAttribute("property") === "title-type" && text(el) === "main",
        )
        ?.getAttribute("refines");
      result.title = text(
        titles.find((el) => main === `#${el.id}`) ?? titles[0],
      );
      result.authors = elements(opf, DC, "creator").map((el) => text(el) || "");
      result.subjects = elements(opf, DC, "subject").map(
        (el) => text(el) || "",
      );
    } catch {
      result.warnings.push(
        "Metadata could not be extracted; filename and empty fields were used.",
      );
    }
    const coverId = elements(opf, OPF, "meta")
      .find((el) => el.getAttribute("name") === "cover")
      ?.getAttribute("content");
    const cover =
      [...manifest.values()].find((el) =>
        el.getAttribute("properties")?.split(/\s+/).includes("cover-image"),
      ) ?? manifest.get(coverId || "");
    if (cover)
      pendingCover = async () =>
        thumbnail(
          await load(
            resource(cover.getAttribute("href") || "", path),
            MAX_COVER_BYTES,
          ),
        );
    return result;
  } catch (error) {
    await archive.close();
    throw error;
  }
}

Object.assign(globalThis, {
  async extractCover(): Promise<{
    cover: Uint8Array | null;
    warnings: string[];
  }> {
    try {
      return { cover: (await pendingCover?.()) ?? null, warnings: [] };
    } catch {
      return {
        cover: null,
        warnings: ["Cover could not be extracted; a placeholder was used."],
      };
    } finally {
      await Promise.allSettled(dispose.map((close) => close()));
    }
  },
  async inspectBook(
    format: BookFormat,
  ): Promise<{ ok: true; value: ExtractedBook } | Failure> {
    try {
      const response = await fetch("/book");
      if (!response.ok) throw new Error("Staged book is unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: true,
        value: await (format === "pdf" ? pdf(bytes) : epub(bytes)),
      };
    } catch (error) {
      if (error instanceof Refusal)
        return { ok: false, code: error.code, message: error.message };
      return {
        ok: false,
        code: "invalid-content",
        message: `The ${format.toUpperCase()} could not be parsed; its content is corrupt or unsupported.`,
      };
    }
  },
});
