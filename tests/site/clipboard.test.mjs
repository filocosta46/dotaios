import test from "node:test";
import assert from "node:assert/strict";
import { copyTextToClipboard } from "../../website/src/clipboard.js";

function createFallback({ result = true, error = null } = {}) {
  const calls = [];
  const area = {
    style: {},
    setAttribute(name, value) {
      calls.push(["setAttribute", name, value]);
    },
    select() {
      calls.push(["select"]);
    },
    remove() {
      calls.push(["remove"]);
    }
  };
  const documentRef = {
    body: {
      append(node) {
        assert.equal(node, area);
        calls.push(["append"]);
      }
    },
    createElement(tag) {
      assert.equal(tag, "textarea");
      calls.push(["createElement", tag]);
      return area;
    },
    execCommand(command) {
      assert.equal(command, "copy");
      calls.push(["execCommand", command]);
      if (error) throw error;
      return result;
    }
  };

  return { area, calls, documentRef };
}

test("returns success when the native Clipboard API writes the text", async () => {
  const writes = [];
  const navigatorRef = {
    clipboard: {
      async writeText(text) {
        writes.push(text);
      }
    }
  };

  assert.equal(await copyTextToClipboard("hello", { navigatorRef }), true);
  assert.deepEqual(writes, ["hello"]);
});

test("returns success when native copy rejects and the fallback succeeds", async () => {
  const fallback = createFallback({ result: true });
  const navigatorRef = { clipboard: { writeText: async () => { throw new Error("denied"); } } };

  assert.equal(await copyTextToClipboard("hello", { navigatorRef, documentRef: fallback.documentRef }), true);
  assert.equal(fallback.area.value, "hello");
  assert.ok(fallback.calls.some(([name]) => name === "execCommand"));
});

test("returns failure when native copy rejects and the fallback returns false", async () => {
  const fallback = createFallback({ result: false });
  const navigatorRef = { clipboard: { writeText: async () => { throw new Error("denied"); } } };

  assert.equal(await copyTextToClipboard("hello", { navigatorRef, documentRef: fallback.documentRef }), false);
});

test("returns failure when native copy rejects and the fallback throws", async () => {
  const fallback = createFallback({ error: new Error("copy unavailable") });
  const navigatorRef = { clipboard: { writeText: async () => { throw new Error("denied"); } } };

  assert.equal(await copyTextToClipboard("hello", { navigatorRef, documentRef: fallback.documentRef }), false);
});

test("always removes the temporary fallback textarea", async () => {
  const fallback = createFallback({ error: new Error("copy unavailable") });

  await copyTextToClipboard("hello", { navigatorRef: {}, documentRef: fallback.documentRef });

  assert.deepEqual(fallback.calls.at(-1), ["remove"]);
  assert.equal(fallback.calls.filter(([name]) => name === "remove").length, 1);
});
