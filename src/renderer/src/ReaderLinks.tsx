import { type RefObject, useEffect, useRef, useState } from "react";
import { externalLink } from "../../shared/links";
import "./reader.css";

/** A book may propose an address. Only this trusted dialog can copy it. */
export function ReaderLinks({
  frame,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (
        !frame.current?.contentWindow ||
        event.source !== frame.current.contentWindow ||
        event.origin !== "borges://reader" ||
        event.data?.type !== "borges:external-link"
      )
        return;
      const link = externalLink(event.data.href);
      if (link) {
        setFeedback("");
        setAddress(link);
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frame]);

  useEffect(() => {
    if (address) dialog.current?.showModal();
    else dialog.current?.close();
  }, [address]);

  return (
    <dialog
      ref={dialog}
      className="reader-link-dialog"
      aria-labelledby="reference-title"
      onCancel={(event) => {
        event.preventDefault();
        setAddress(null);
      }}
    >
      <h2 id="reference-title">External reference</h2>
      <p>Copy this address to use outside Borges.</p>
      <label>
        Link address
        <input readOnly value={address ?? ""} />
      </label>
      <p role="status">{feedback}</p>
      <div>
        <button
          type="button"
          onClick={() => {
            if (address)
              window.borges.reader.copyLink(address).then(
                () => setFeedback("Link copied"),
                () =>
                  setFeedback(
                    "Could not copy. Select the address and copy it manually.",
                  ),
              );
          }}
        >
          Copy Link
        </button>
        <button type="button" onClick={() => setAddress(null)}>
          Close
        </button>
      </div>
    </dialog>
  );
}
