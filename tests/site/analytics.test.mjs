import assert from "node:assert/strict";
import test from "node:test";
import { trackPublicIntent } from "../../website/src/analytics.js";
import { PUBLIC_EVENT_NAMES } from "../../website/src/offer.js";

class TestCustomEvent {
  constructor(type, options) {
    this.type = type;
    this.detail = options.detail;
  }
}

test("public intents dispatch the allowed event contract", () => {
  const dispatched = [];
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = { dispatchEvent: (event) => dispatched.push(event) };
  globalThis.CustomEvent = TestCustomEvent;

  try {
    for (const name of PUBLIC_EVENT_NAMES) {
      assert.deepEqual(trackPublicIntent(name, "it"), { name, language: "it" });
    }
    assert.equal(dispatched.length, PUBLIC_EVENT_NAMES.length);
    assert.ok(dispatched.every((event) => event.type === "dotaios:interaction"));
    assert.deepEqual(dispatched[0].detail, {
      name: PUBLIC_EVENT_NAMES[0],
      language: "it",
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});

test("public intents normalize language and reject unknown names", () => {
  const dispatched = [];
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = { dispatchEvent: (event) => dispatched.push(event) };
  globalThis.CustomEvent = TestCustomEvent;

  try {
    assert.equal(trackPublicIntent(PUBLIC_EVENT_NAMES[0], "fr").language, "en");
    assert.throws(() => trackPublicIntent("unknown_event", "en"), /Unknown public intent event/);
    assert.equal(dispatched.length, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});
