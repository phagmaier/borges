import { useEffect, useRef, useState } from "react";
import type { BookSummary } from "../../../shared/runtime";

// At most four cover reads/decodes in flight. Queued requests for cards that
// have left the viewport are skipped; object URLs are released on exit.
const pending: (() => Promise<void>)[] = [];
let active = 0;
function drain() {
  while (active < 4 && pending.length) {
    const job = pending.shift();
    if (!job) return;
    active++;
    void job().finally(() => {
      active--;
      drain();
    });
  }
}

export function Cover({ book }: { book: BookSummary }) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        root: target.closest(".library-main"),
        rootMargin: "200px",
      },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setImage(null);
    if (!visible || !book.coverToken) return;
    let current = true;
    let objectUrl: string | null = null;
    const token = book.coverToken;
    pending.push(async () => {
      if (!current) return;
      try {
        const result = await window.borges.library.cover(book.id, token);
        if (!current || !result.ok || !result.value) return;
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.value)], { type: "image/png" }),
        );
        const decoded = new Image();
        decoded.src = objectUrl;
        await decoded.decode();
        if (current) setImage(objectUrl);
      } catch {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        /* Missing/unusable cover keeps its placeholder. */
      }
    });
    drain();
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, book.id, book.coverToken]);
  const initials = book.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  return (
    <span
      ref={element}
      className={`cover ${image ? "has-image" : "placeholder"} ${book.format}`}
      aria-hidden="true"
    >
      {image ? (
        <img src={image} alt="" onError={() => setImage(null)} />
      ) : (
        <>
          <span className="initials">{initials}</span>
          <span className="format">{book.format.toUpperCase()}</span>
        </>
      )}
    </span>
  );
}
