import type { StoredSizing } from "../../library/progress";
import { EpubSession } from "../../readers/epub";
import { PdfSession } from "../../readers/pdf";
import {
  parseSnapshot,
  ReaderInputError,
  type ReaderLocation,
  type ReaderSession,
  type ReaderSizing,
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
const darkMode = element<HTMLButtonElement>("#dark-mode");
const snapshot = element<HTMLTextAreaElement>("#snapshot");
let session: ReaderSession;
let revision = "";
let disposed = false;
let commands = Promise.resolve();
let commandFailed = false;
let search: AbortController | undefined;
let hits: SearchHit[] = [];
let selected = -1;
let queryVersion = 0;
function report(reason: unknown) {
  alert.hidden = catalogMode && !(reason instanceof ReaderInputError);
  alert.textContent = String(reason);
  if (!(reason instanceof ReaderInputError))
    tellParent({ type: "borges:error", message: String(reason) });
}
function run(
  action: () => Promise<void>,
  clearError = true,
  captureAfter = true,
) {
  commands = commands
    .then(async () => {
      if (disposed) return;
      if (clearError) alert.hidden = true;
      await action();
      if (captureAfter) {
        commandFailed = false;
        reportPosition();
      }
    })
    .catch((reason: unknown) => {
      if (!(reason instanceof ReaderInputError)) commandFailed = true;
      report(reason);
    });
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
const controlsToggle = element<HTMLButtonElement>("#controls-toggle");
const controlsShow = element<HTMLButtonElement>("#controls-show");
function toggleControls(
  show = controlsToggle.getAttribute("aria-expanded") !== "true",
) {
  controlsToggle.setAttribute("aria-expanded", String(show));
  controlsShow.setAttribute("aria-expanded", String(show));
  controlsShow.hidden = show;
  document.body.classList.toggle("controls-hidden", !show);
  element("nav").hidden = !show;
  element("#location").hidden = !show;
}
controlsToggle.onclick = controlsShow.onclick = () => {
  toggleControls();
  surface.focus();
};
function handleKey(event: KeyboardEvent) {
  if (!session || disposed || document.body.inert || element("nav").inert)
    return;
  if (event.defaultPrevented || event.altKey || event.metaKey) return;
  if (event.key === "F9") {
    event.preventDefault();
    toggleControls();
    surface.focus();
    return;
  }
  if (event.ctrlKey && ["+", "=", "-"].includes(event.key)) {
    event.preventDefault();
    resizeBy(event.key === "-" ? -1 : 1);
    return;
  }
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
    toggleControls(true);
    element<HTMLInputElement>('input[name="jump"]').focus();
  }
}
document.addEventListener("keydown", handleKey);
let wheelBusy = false;
let wheelUntil = 0;
function handleWheel(event: WheelEvent) {
  const target = event.target as Element | null;
  if (
    !session ||
    disposed ||
    document.body.inert ||
    element("nav").inert ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    target?.closest(
      'input,textarea,select,button,[contenteditable],dialog,[role="dialog"],[role="listbox"]',
    ) ||
    Math.abs(event.deltaY) <= Math.abs(event.deltaX)
  )
    return;
  // Zoomed fixed pages keep native pan. Fit-page and reflowable wheels turn pages.
  if (
    (session.format === "pdf" &&
      surface.scrollHeight > surface.clientHeight + 1) ||
    (!session.reflowable && session.sizing.zoom > 1)
  )
    return;
  if (!event.deltaY) return;
  event.preventDefault();
  const now = performance.now();
  if (wheelBusy || now < wheelUntil) return;
  wheelUntil = now + 180; // Group brief bursts without blocking sustained scrolling.
  wheelBusy = true;
  void run(() => session.turn(event.deltaY > 0 ? 1 : -1)).finally(() => {
    wheelBusy = false;
  });
}
surface.addEventListener("wheel", handleWheel, { passive: false });
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
    throw new ReaderInputError("Font size must be 8–72; zoom must be 0.25–8.");
  await session.setSizing({ ...session.sizing, fontSize, zoom: value });
  reportPosition();
}
function resizeBy(direction: number) {
  void run(async () => {
    if (session.reflowable)
      font.value = String(
        Math.max(8, Math.min(72, session.sizing.fontSize + direction * 2)),
      );
    else
      zoom.value = String(
        Math.max(0.25, Math.min(8, session.sizing.zoom + direction * 0.25)),
      );
    await size();
  });
}
font.onchange = zoom.onchange = () => {
  void run(size);
};
element("#fit").onclick = () => {
  zoom.value = "1";
  void run(size);
};
function syncTheme() {
  const dark = session.sizing.theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "original";
  darkMode.setAttribute("aria-pressed", String(dark));
  tellParent({ type: "borges:theme", theme: dark ? "dark" : "original" });
}
darkMode.onclick = () => {
  void run(async () => {
    await session.setSizing({
      ...session.sizing,
      theme: session.sizing.theme === "dark" ? "original" : "dark",
    });
    syncTheme();
  });
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
    syncTheme();
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
  sizing: StoredSizing;
}
let parentOrigin: string | null = null;
let reporting = false;
let lastPosition:
  | { type: "borges:position"; location: ReaderLocation; sizing: ReaderSizing }
  | undefined;
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== parentOrigin) return;
  if (event.data?.type === "borges:shortcut") {
    if (!session || disposed || document.body.inert || element("nav").inert)
      return;
    if (event.data.action === "larger") resizeBy(1);
    else if (event.data.action === "smaller") resizeBy(-1);
    else if (event.data.action === "controls") toggleControls();
  } else if (event.data?.type === "borges:resume") {
    document.body.inert = false;
  } else if (
    event.data?.type === "borges:drain" &&
    typeof event.data.token === "string"
  ) {
    document.body.inert = true;
    const token = event.data.token;
    void run(
      async () => {
        // A failed engine command may have partially moved its internal state.
        // Keep the last working location rather than acknowledging that state.
        if (commandFailed && lastPosition) tellParent(lastPosition);
        else reportPosition(); // Includes pan whose throttled report has not fired.
        tellParent({ type: "borges:drained", token });
      },
      false,
      false,
    );
  }
});
function tellParent(message: object) {
  if (parentOrigin) window.parent.postMessage(message, parentOrigin);
}
function reportPosition() {
  if (!reporting || disposed || commandFailed) return;
  lastPosition = {
    type: "borges:position",
    location: session.capture(),
    sizing: { ...session.sizing },
  };
  tellParent(lastPosition);
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
  session = isPdf ? new PdfSession() : new EpubSession(handleKey, handleWheel);
  if (book?.sizing.theme) session.sizing.theme = book.sizing.theme;
  syncTheme();
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
  surface.dataset.fixed = String(!session.reflowable);
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
      ...session.sizing,
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
  let resizeVersion = 0;
  let appliedResize = 0;
  const resize = () => {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(() => {
      void run(async () => {
        appliedResize = resizeVersion;
        await session.resize();
      }, false).finally(() => {
        queued = false;
        // At most one resize command is queued, even during a long paint.
        // If the viewport changed during it, apply the latest size next.
        if (appliedResize !== resizeVersion) resize();
      });
    });
  };
  observer = new ResizeObserver(() => {
    resizeVersion++;
    resize();
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
