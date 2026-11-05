/** A rejected reader control value; the engine remains usable. */
export class ReaderInputError extends Error {}

export type ReaderLocation =
  | { format: "pdf"; page: number; x: number; y: number }
  | {
      format: "epub";
      cfi: string;
      section: number;
      fraction: number;
      x: number;
      y: number;
    };
export interface ReaderSizing {
  fontSize: number;
  zoom: number;
}
export interface ReaderSnapshot {
  version: 1;
  revision: string;
  location: ReaderLocation;
  sizing: ReaderSizing;
}
export interface SearchHit {
  location: ReaderLocation;
  label: string;
  excerpt: string;
  query: string;
  occurrence?: number;
}
export interface SearchBatch {
  hits: SearchHit[];
  hasText: boolean;
}
export interface ContentsItem {
  label: string;
  target: ReaderLocation;
}
export type Restoration = "exact" | "approximate" | "beginning";
/** Events: relocate; navigate (ReaderLocation); external-link (plain address). */
export interface ReaderSession extends EventTarget {
  readonly format: "pdf" | "epub";
  readonly reflowable: boolean;
  readonly sizing: ReaderSizing;
  readonly contents: ContentsItem[];
  readonly label: string;
  readonly visibleText: string;
  open(file: File, surface: HTMLElement): Promise<void>;
  turn(direction: -1 | 1): Promise<void>;
  jump(value: string): Promise<void>;
  capture(): ReaderLocation;
  restore(location: ReaderLocation): Promise<Restoration>;
  setSizing(sizing: ReaderSizing): Promise<void>;
  resize(): Promise<void>;
  search(query: string, signal: AbortSignal): AsyncGenerator<SearchBatch>;
  showHit(hit: SearchHit): Promise<void>;
  clearSearch(): void;
  dispose(): Promise<void>;
}

/** Diagnostic snapshots are untrusted input and bound to exact document bytes. */
export function parseSnapshot(text: string, revision: string): ReaderSnapshot {
  const value = JSON.parse(text);
  const unit = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const location = value?.location;
  const sizing = value?.sizing;
  if (
    value?.version !== 1 ||
    value.revision !== revision ||
    !location ||
    !sizing ||
    !unit(location.x) ||
    !unit(location.y) ||
    !(
      Number.isFinite(sizing.fontSize) &&
      sizing.fontSize >= 8 &&
      sizing.fontSize <= 72
    ) ||
    !(
      Number.isFinite(sizing.zoom) &&
      sizing.zoom >= 0.25 &&
      sizing.zoom <= 8
    ) ||
    !(location.format === "pdf"
      ? Number.isInteger(location.page) && location.page >= 1
      : location.format === "epub" &&
        typeof location.cfi === "string" &&
        location.cfi.length <= 16384 &&
        Number.isInteger(location.section) &&
        location.section >= 0 &&
        unit(location.fraction))
  ) {
    throw new Error("Invalid snapshot or different document revision.");
  }
  return value as ReaderSnapshot;
}

export function panPosition(element: HTMLElement) {
  return {
    x:
      Math.max(0, element.scrollLeft) /
      Math.max(1, element.scrollWidth - element.clientWidth),
    y:
      Math.max(0, element.scrollTop) /
      Math.max(1, element.scrollHeight - element.clientHeight),
  };
}
export function restorePan(
  element: HTMLElement,
  position: { x: number; y: number },
) {
  element.scrollLeft = position.x * (element.scrollWidth - element.clientWidth);
  element.scrollTop =
    position.y * (element.scrollHeight - element.clientHeight);
}
