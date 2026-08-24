import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBaseCompensation,
  resolveAgainst,
  workerLocation,
} from "../src/content/worker-scope";
import type { PatchableScope } from "../src/content/worker-scope";

const BASE = "https://app.test/js/worker.js";

/**
 * Instrumenting a worker means starting it from a `blob:` URL, which moves the
 * worker's base URL. Every test here is one way a page could notice that move,
 * and the assertion is that it cannot.
 */

test("relative specifiers resolve against the real script, not the blob", () => {
  assert.equal(resolveAgainst(BASE, "./data.bin"), "https://app.test/js/data.bin");
  assert.equal(resolveAgainst(BASE, "/api/x"), "https://app.test/api/x");
  assert.equal(resolveAgainst(BASE, "https://other.test/y"), "https://other.test/y");
  assert.equal(resolveAgainst(BASE, new URL("https://other.test/y")), "https://other.test/y");
});

test("anything that is not a URL is handed back untouched", () => {
  // A `Request` already carries an absolute URL, and a `TrustedScriptURL` stops
  // being trusted the moment it is stringified.
  const request = { url: "https://app.test/x" };
  assert.equal(resolveAgainst(BASE, request), request);
  assert.equal(resolveAgainst(BASE, undefined), undefined);
  assert.equal(resolveAgainst(BASE, 42), 42);
});

test("an unparseable specifier stays the platform's error to report", () => {
  assert.equal(resolveAgainst("not a url", "./x"), "./x");
});

test("location reports the script the page asked for", () => {
  const location = workerLocation(BASE);
  assert.equal(location["href"], BASE);
  assert.equal(location["origin"], "https://app.test");
  assert.equal(location["pathname"], "/js/worker.js");
  // `"" + location` and `new URL("./x", location)` are both common idioms.
  assert.equal(String(location), BASE);
});

function scope(): PatchableScope & Record<string, unknown> {
  const calls: string[] = [];
  const target = {
    calls,
    location: { href: "blob:https://app.test/0000-1111" },
    importScripts: (...urls: string[]) => calls.push(`importScripts:${urls.join(",")}`),
    fetch: (input: unknown) => {
      calls.push(`fetch:${String(input)}`);
      return Promise.resolve("response");
    },
    navigator: { sendBeacon: (url: string) => (calls.push(`beacon:${url}`), true) },
    XMLHttpRequest: class {
      open(method: string, url: string): void {
        calls.push(`xhr:${method}:${url}`);
      }
    },
    WebSocket: class {
      constructor(url: string) {
        calls.push(`ws:${url}`);
      }
    },
    Worker: class {
      constructor(url: string) {
        calls.push(`worker:${url}`);
      }
    },
    Request: class {
      constructor(url: string) {
        calls.push(`request:${url}`);
      }
    },
    EventSource: class {
      constructor(url: string) {
        calls.push(`sse:${url}`);
      }
    },
  };
  return target as unknown as PatchableScope & Record<string, unknown>;
}

test("every URL-taking API in the worker resolves against the real script", async () => {
  const target = scope();
  applyBaseCompensation(target, BASE);

  target.importScripts!("./helper.js");
  await target.fetch!("./data.bin");
  target.navigator!.sendBeacon!("/metrics");
  new (target["XMLHttpRequest"] as new () => { open: (m: string, u: string) => void })().open(
    "GET",
    "./api",
  );
  new (target["WebSocket"] as new (url: string) => unknown)("/socket");
  new (target["Worker"] as new (url: string) => unknown)("./child.js");
  new (target["Request"] as new (url: string) => unknown)("./req");
  new (target["EventSource"] as new (url: string) => unknown)("./events");

  assert.deepEqual(target["calls"], [
    "importScripts:https://app.test/js/helper.js",
    "fetch:https://app.test/js/data.bin",
    "beacon:https://app.test/metrics",
    "xhr:GET:https://app.test/js/api",
    "ws:https://app.test/socket",
    "worker:https://app.test/js/child.js",
    "request:https://app.test/js/req",
    "sse:https://app.test/js/events",
  ]);
});

test("self.location is replaced, so scripts that build their own URLs still work", () => {
  const target = scope();
  applyBaseCompensation(target, BASE);

  const location = target.location as { href: string };
  assert.equal(location.href, BASE);
  assert.equal(new URL("./sibling.wasm", String(location)).href, "https://app.test/js/sibling.wasm");
});

test("a scope missing half the platform is patched as far as it goes", () => {
  // Not every worker global has every API, and a compensation pass that throws
  // would take the worker's own script down with it.
  const bare: PatchableScope = { fetch: (input) => String(input) };
  assert.doesNotThrow(() => applyBaseCompensation(bare, BASE));
  assert.equal(bare.fetch!("./x"), "https://app.test/js/x");
});
