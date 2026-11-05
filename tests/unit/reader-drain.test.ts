import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { ReaderDrain } from "../../src/main/reader-drain";

function contents(id: number) {
  return Object.assign(new EventEmitter(), { id, send: vi.fn() });
}
afterEach(() => vi.useRealTimers());

it("accepts only the requested owner and token and coalesces concurrent drains", async () => {
  const drain = new ReaderDrain();
  const target = contents(7);
  const pending = drain.request(target as unknown as WebContents);
  expect(drain.request(target as unknown as WebContents)).toBe(pending);
  expect(target.send).toHaveBeenCalledTimes(1);
  const token = target.send.mock.calls[0]?.[1];
  let completed = false;
  void pending.then(() => {
    completed = true;
  });
  drain.complete(8, token);
  drain.complete(7, "replayed-token");
  drain.complete(9, undefined);
  await Promise.resolve();
  expect(completed).toBe(false);
  drain.complete(7, token);
  await pending;
  expect(completed).toBe(true);
  expect(target.listenerCount("destroyed")).toBe(0);
});

it("bounds an unanswered drain, cleans up and allows a later retry", async () => {
  vi.useFakeTimers();
  const drain = new ReaderDrain();
  const target = contents(7);
  const pending = drain.request(target as unknown as WebContents);
  const failure = expect(pending).rejects.toThrow("did not answer");
  await vi.advanceTimersByTimeAsync(5000);
  await failure;
  expect(target.listenerCount("destroyed")).toBe(0);
  const retry = drain.request(target as unknown as WebContents);
  drain.complete(7, target.send.mock.calls[1]?.[1]);
  await retry;
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a destroyed reader immediately and releases its deadline", async () => {
  vi.useFakeTimers();
  const drain = new ReaderDrain();
  const target = contents(7);
  const pending = drain.request(target as unknown as WebContents);
  target.emit("destroyed");
  await expect(pending).rejects.toThrow("closed before");
  expect(vi.getTimerCount()).toBe(0);
  expect(target.listenerCount("destroyed")).toBe(0);
});
