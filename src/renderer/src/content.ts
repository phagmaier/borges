import { EpubSession } from "../../readers/epub";
import { PdfSession } from "../../readers/pdf";
import {
  parseSnapshot,
  type ReaderLocation,
  type ReaderSession,
  type Restoration,
  type SearchHit,
} from "../../readers/session";
import "pdfjs-dist/web/pdf_viewer.css";
import "./content.css";

const fixtures = new Map([
  ["sample-pdf", "known.pdf"],
  ["image-pdf", "image-only.pdf"],
  ["sample-epub", "reflowable.epub"],
  ["fixed-epub", "fixed.epub"],
  ["font-epub", "obfuscated.epub"],
]);
function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing reader control: ${selector}`);
  return found;
}
const surface = element<HTMLDivElement>("#surface");
const status = element<HTMLParagraphElement>('[role="status"]');
const alert = element<HTMLParagraphElement>('[role="alert"]');
const query = element<HTMLInputElement>("#query");
const panel = element<HTMLElement>("#search-panel");
const results = element<HTMLOListElement>("#results");
const searchStatus = element<HTMLElement>("#search-status");
const jump = element<HTMLFormElement>("#jump-form");
const font = element<HTMLInputElement>("#font");
const zoom = element<HTMLInputElement>("#zoom");
const snapshot = element<HTMLTextAreaElement>("#snapshot");
let session: ReaderSession;
let revision = "";
let disposed = false;
let commands = Promise.resolve();
let search: AbortController | undefined;
let hits: SearchHit[] = [];
let selected = -1;
let queryVersion = 0;
function report(reason: unknown) {
  alert.hidden = false;
  alert.textContent = String(reason);
}
function run(action: () => Promise<void>, clearError = true) {
  commands = commands
    .then(async () => {
      if (disposed) return;
      if (clearError) alert.hidden = true;
      await action();
    })
    .catch(report);
  return commands;
}
function closeSearch() {
  search?.abort();
  hits = [];
  results.replaceChildren();
  panel.hidden = true;
  session.clearSearch();
  surface.focus();
}
function showSearch() {
  const reopening = panel.hidden;
  panel.hidden = false;
  query.focus();
  if (reopening) void searchBook();
}
function handleKey(event: KeyboardEvent) {
  const target = event.target as Element | null;
  if (
    target?.closest(
      'input,textarea,select,button,a,[contenteditable],dialog,[role="dialog"],ul,ol,menu,[role="list"],[role="listbox"]',
    ) ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const action =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (action) {
    event.preventDefault();
    void run(() => session.turn(action));
  } else if (event.key === "/") {
    event.preventDefault();
    showSearch();
  } else if (event.key === ":") {
    event.preventDefault();
    element<HTMLInputElement>('input[name="jump"]').focus();
  }
}
surface.addEventListener("keydown", handleKey);
async function searchBook() {
  search?.abort();
  session.clearSearch();
  const version = ++queryVersion;
  const current = new AbortController();
  search = current;
  hits = [];
  selected = -1;
  results.replaceChildren();
  const text = query.value.trim();
  if (!text) {
    searchStatus.textContent = "Enter search text.";
    return;
  }
  let hasText = false;
  searchStatus.textContent = "Searching…";
  try {
    for await (const batch of session.search(text, current.signal)) {
      if (current.signal.aborted) return;
      hasText ||= batch.hasText;
      for (const hit of batch.hits) {
        const index = hits.length;
        hits.push(hit);
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${hit.label}: ${hit.excerpt}`;
        button.onclick = () => {
          selected = index;
          void run(async () => {
            if (version === queryVersion) {
              await session.showHit(hit);
              if (panel.hidden || version !== queryVersion)
                session.clearSearch();
            }
          });
        };
        li.append(button);
        results.append(li);
      }
      searchStatus.textContent = `Searching… ${hits.length} matches`;
    }
    if (!current.signal.aborted)
      searchStatus.textContent = hits.length
        ? `${hits.length} matches`
        : hasText
          ? "No matches"
          : "Text unavailable in this book";
  } catch (reason) {
    if (!current.signal.aborted) report(reason);
  }
}
query.addEventListener("input", () => {
  void searchBook();
});
query.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
  if (event.key === "Enter" && hits.length) {
    event.preventDefault();
    selected =
      selected < 0
        ? event.shiftKey
          ? hits.length - 1
          : 0
        : (selected + (event.shiftKey ? -1 : 1) + hits.length) % hits.length;
    const hit = hits[selected];
    if (hit) {
      const version = queryVersion;
      void run(async () => {
        if (version === queryVersion) {
          await session.showHit(hit);
          if (panel.hidden || version !== queryVersion) session.clearSearch();
        }
      });
    }
  }
});
panel.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
element("#search-toggle").onclick = showSearch;
element("#search-close").onclick = closeSearch;
element("#previous").onclick = () => {
  void run(() => session.turn(-1));
};
element("#next").onclick = () => {
  void run(() => session.turn(1));
};
function jumpToInput() {
  const value = element<HTMLInputElement>('input[name="jump"]').value;
  void run(async () => {
    await session.jump(value);
    surface.focus();
  });
}
jump.addEventListener("submit", (event) => event.preventDefault());
element<HTMLInputElement>('input[name="jump"]').addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToInput();
    }
  },
);
element("#jump-go").onclick = jumpToInput;
const contents = element<HTMLSelectElement>("#contents");
contents.onchange = () => {
  if (!contents.value) return;
  const target = session.contents[Number(contents.value)]?.target;
  // This is a navigation action; allow choosing the same destination again
  // after a page turn, jump or search moved elsewhere.
  contents.value = "";
  if (target)
    void run(async () => {
      await session.restore(target);
      surface.focus();
    });
};
async function size() {
  const fontSize = Number(font.value);
  const value = Number(zoom.value);
  if (
    !Number.isFinite(fontSize) ||
    fontSize < 8 ||
    fontSize > 72 ||
    !Number.isFinite(value) ||
    value < 0.25 ||
    value > 8
  )
    throw new Error("Font size must be 8–72; zoom must be 0.25–8.");
  await session.setSizing({ fontSize, zoom: value });
  reportPosition();
}
font.onchange = zoom.onchange = () => {
  void run(size);
};
element("#fit").onclick = () => {
  zoom.value = "1";
  void run(size);
};
element("#capture").onclick = () => {
  void run(async () => {
    snapshot.value = JSON.stringify({
      version: 1,
      revision,
      location: session.capture(),
      sizing: session.sizing,
    });
  });
};
element("#restore").onclick = () => {
  void run(async () => {
    const saved = parseSnapshot(snapshot.value, revision);
    if (saved.location.format !== session.format)
      throw new Error("Snapshot format mismatch.");
    await session.setSizing(saved.sizing);
    font.value = String(saved.sizing.fontSize);
    zoom.value = String(saved.sizing.zoom);
    const result = await session.restore(saved.location);
    status.textContent =
      result === "exact"
        ? "Ready · exact restoration"
        : result === "approximate"
          ? "Ready · approximate restoration"
          : "Ready · restarted at beginning";
  });
};
let observer: ResizeObserver | undefined;
const catalogMode = new URL(location.href).searchParams.has("catalog");
// Catalog books hide the diagnostic snapshot tools (they save automatically).
document.body.dataset.mode = catalogMode ? "catalog" : "diagnostic";

// Catalog books arrive from the parent reader shell, which owns the session
// and relays positions to the application. This frame never sees session
// tokens, and it answers only the parent at the origin that opened it.
interface OpenMessage {
  type: "borges:open";
  fileName: string;
  format: "pdf" | "epub";
  bytes: ArrayBuffer;
  location: ReaderLocation | null;
  sizing: { fontSize: number | null; zoom: number | null };
}
let parentOrigin: string | null = null;
let reporting = false;
function tellParent(message: object) {
  if (parentOrigin) window.parent.postMessage(message, parentOrigin);
}
function reportPosition() {
  if (!reporting || disposed) return;
  tellParent({
    type: "borges:position",
    location: session.capture(),
    sizing: session.sizing,
  });
}
function receiveBook(): Promise<OpenMessage> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const data = event.data as Partial<OpenMessage> | null;
      if (
        event.source !== window.parent ||
        data?.type !== "borges:open" ||
        !(data.bytes instanceof ArrayBuffer) ||
        typeof data.fileName !== "string" ||
        (data.format !== "pdf" && data.format !== "epub")
      )
        return;
      window.removeEventListener("message", listener);
      parentOrigin = event.origin;
      resolve(data as OpenMessage);
    };
    window.addEventListener("message", listener);
    window.parent.postMessage({ type: "borges:ready" }, "*");
  });
}

async function fixtureBook(): Promise<{ bytes: ArrayBuffer; name: string }> {
  const filename = fixtures.get(
    new URL(location.href).searchParams.get("book") ?? "",
  );
  if (!filename) throw new Error("Unknown diagnostic fixture.");
  const response = await fetch(`/reader-assets/fixtures/${filename}`);
  if (!response.ok) throw new Error(`Fixture unavailable: ${response.status}`);
  return { bytes: await response.arrayBuffer(), name: filename };
}

async function open() {
  const book = catalogMode ? await receiveBook() : null;
  const { bytes, name } = book
    ? { bytes: book.bytes, name: book.fileName }
    : await fixtureBook();
  revision = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const isPdf = book ? book.format === "pdf" : name.endsWith(".pdf");
  session = isPdf ? new PdfSession() : new EpubSession(handleKey);
  session.addEventListener("navigate", (event) => {
    const target = (event as CustomEvent<ReaderLocation>).detail;
    void run(async () => {
      // foliate queues scrolling to the focused source link on the next
      // frame. Let that settle before navigating to the link's destination,
      // or its focus handler can return the reader to the source afterwards.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await session.restore(target);
    });
  });
  session.addEventListener("external-link", (event) => {
    // Diagnostic readers have no open-book handshake, but use the same shell.
    window.parent.postMessage(
      {
        type: "borges:external-link",
        href: (event as CustomEvent<string>).detail,
      },
      parentOrigin ?? "*",
    );
  });
  session.addEventListener("relocate", () => {
    element("#location").textContent = session.label;
    element("#visible-text").textContent = session.visibleText;
    reportPosition();
  });
  await session.open(new File([bytes], name), surface);
  element("#font-control").hidden = !session.reflowable;
  element("#zoom-control").hidden = session.reflowable;
  element("#fit").hidden = session.reflowable;
  for (const [index, item] of session.contents.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = item.label;
    contents.append(option);
  }
  contents.disabled = !session.contents.length;
  let restoration: Restoration | "none" = "none";
  if (book) {
    const sizing = {
      fontSize: book.sizing.fontSize ?? session.sizing.fontSize,
      zoom: book.sizing.zoom ?? session.sizing.zoom,
    };
    font.value = String(sizing.fontSize);
    zoom.value = String(sizing.zoom);
    await session.setSizing(sizing);
    if (book.location) restoration = await session.restore(book.location);
  }
  element("nav").inert = false;
  element("#location").textContent = session.label;
  element("#visible-text").textContent = session.visibleText;
  status.textContent = "Ready";
  // Announced, then kept out of the way of the page.
  status.dataset.state = "ready";
  if (book) {
    tellParent({ type: "borges:opened", restoration });
    reporting = true;
    reportPosition();
    // Pan within a zoomed PDF page is part of its position.
    let panQueued = false;
    surface.addEventListener("scroll", () => {
      if (panQueued) return;
      panQueued = true;
      setTimeout(() => {
        panQueued = false;
        reportPosition();
      }, 100);
    });
  }
  let queued = false;
  observer = new ResizeObserver(() => {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      void run(() => session.resize(), false);
    });
  });
  observer.observe(surface);
}
open().catch(async (reason: unknown) => {
  status.hidden = true;
  report(reason);
  tellParent({ type: "borges:failed", message: String(reason) });
  await session?.dispose().catch(console.error);
});
window.addEventListener("pagehide", () => {
  disposed = true;
  search?.abort();
  observer?.disconnect();
  void session?.dispose().catch(console.error);
});
