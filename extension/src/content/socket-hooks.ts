/**
 * Counting WebSocket activity, as corroboration and nothing more.
 *
 * A mining pool hands out work and takes back shares over a persistent socket,
 * so a module that computes continuously *and* keeps a socket busy is a
 * different proposition from one that only computes. On its own this signal is
 * worth very little -- every chat, every live dashboard and every collaborative
 * editor holds a socket open -- which is why the rule that reads it requires
 * measured execution time alongside.
 *
 * Only counts are kept. Not URLs, not payloads, not sizes: what is sent over a
 * page's own socket is the page's business, and a security tool that reads it
 * is doing the thing it exists to prevent.
 */
import type { RuntimeMonitor } from "./runtime-monitor";

/** The slice of a global scope this touches. */
export interface SocketScope {
  WebSocket?: unknown;
}

/**
 * Wrap `WebSocket` so opens and messages are counted.
 *
 * A `Proxy` with a `construct` trap, for the same reasons as the `Module` hook:
 * `new` is forwarded, `instanceof` keeps working for page code, and the static
 * constants (`WebSocket.OPEN` and the rest) are untouched.
 */
export function installSocketHooks(scope: SocketScope, monitor: RuntimeMonitor): void {
  const original = scope.WebSocket;
  if (typeof original !== "function") return;

  scope.WebSocket = new Proxy(original as new (...args: unknown[]) => EventTarget, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as EventTarget;
      try {
        monitor.noteSocket();

        // A listener rather than a wrapped `onmessage`: the page is free to
        // assign, reassign or never set that property, and none of those should
        // change whether we see traffic. Ours is registered first and never
        // stops propagation, so the page's handlers run exactly as before.
        socket.addEventListener("message", () => monitor.noteSocketMessage());

        const send = (socket as unknown as { send?: unknown }).send;
        if (typeof send === "function") {
          (socket as unknown as { send: unknown }).send = function counted(
            this: unknown,
            ...sendArgs: unknown[]
          ): unknown {
            try {
              monitor.noteSocketMessage();
            } catch {
              /* Counting must never break a send. */
            }
            return (send as (...a: unknown[]) => unknown).apply(this, sendArgs);
          };
        }
      } catch {
        /* An exotic socket implementation costs us a count, nothing more. */
      }
      return socket;
    },
  });
}
