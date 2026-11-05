import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

/** Wait for commands already queued in a reader's engine, then capture its
 * final position. Tokens bind replies to one request and one shell owner. */
export class ReaderDrain {
  private readonly pending = new Map<
    number,
    { token: string; finish(error?: Error): void; promise: Promise<void> }
  >();

  request(contents: WebContents): Promise<void> {
    const previous = this.pending.get(contents.id);
    if (previous) return previous.promise;
    const token = randomUUID();
    let finish!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      finish = (error?: Error) => {
        clearTimeout(timer);
        contents.off("destroyed", destroyed);
        this.pending.delete(contents.id);
        if (error) reject(error);
        else resolve();
      };
    });
    const destroyed = () =>
      finish(
        new Error("The reader closed before its final position was received."),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "The reader did not answer. Its latest position could not be captured.",
          ),
        ),
      5000,
    );
    contents.once("destroyed", destroyed);
    this.pending.set(contents.id, { token, finish, promise });
    try {
      contents.send("reader:drain", token);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  complete(owner: number, token: unknown): void {
    const pending = this.pending.get(owner);
    if (pending && pending.token === token) pending.finish();
  }
}
