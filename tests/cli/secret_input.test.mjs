import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readSecretInput } from "../../packages/cli/src/lib/secret-input.mjs";

function terminal({ raw = false, paused = false } = {}) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = raw;
  let isPaused = paused;
  input.setEncoding = () => {};
  input.isPaused = () => isPaused;
  input.resume = () => { isPaused = false; };
  input.pause = () => { isPaused = true; };
  input.setRawMode = (value) => { input.isRaw = value; };
  const writes = [];
  const output = { write: (value) => writes.push(value) };
  return { input, output, writes, isPaused: () => isPaused };
}

test("secure token input never echoes the secret and restores terminal mode", async () => {
  const { input, output, writes } = terminal();
  const reading = readSecretInput({ prompt: "Token: ", input, output, signalEmitter: new EventEmitter() });
  input.emit("data", "ghp_SUPER_SECRET\r");
  assert.equal(await reading, "ghp_SUPER_SECRET");
  assert.equal(input.isRaw, false);
  assert.doesNotMatch(writes.join(""), /ghp_SUPER_SECRET/);
});

test("secure token input restores terminal mode on interrupt and refuses non-TTY input", async () => {
  const { input, output } = terminal();
  const signals = new EventEmitter();
  const reading = readSecretInput({ prompt: "Token: ", input, output, signalEmitter: signals });
  signals.emit("SIGINT");
  await assert.rejects(reading, /interrupted/i);
  assert.equal(input.isRaw, false);

  await assert.rejects(
    readSecretInput({ input: { isTTY: false }, output, signalEmitter: signals }),
    /secure interactive terminal/i
  );
});

test("secure token input restores terminal mode on stream error and cancellation", async () => {
  const errored = terminal();
  const errorRead = readSecretInput({
    input: errored.input,
    output: errored.output,
    signalEmitter: new EventEmitter()
  });
  errored.input.emit("error", new Error("terminal failed"));
  await assert.rejects(errorRead, /terminal failed/);
  assert.equal(errored.input.isRaw, false);

  const cancelled = terminal();
  const controller = new AbortController();
  const cancelledRead = readSecretInput({
    input: cancelled.input,
    output: cancelled.output,
    signalEmitter: new EventEmitter(),
    abortSignal: controller.signal
  });
  controller.abort();
  await assert.rejects(cancelledRead, /cancelled/i);
  assert.equal(cancelled.input.isRaw, false);
});

test("secure token input handles Ctrl-D and end without leaking or leaving raw mode", async () => {
  for (const [label, stop, message] of [
    ["Ctrl-D", (input) => input.emit("data", "secret\u0004"), /cancelled/i],
    ["stream end", (input) => input.emit("end"), /ended before Enter/i]
  ]) {
    const candidate = terminal();
    const reading = readSecretInput({
      prompt: `${label}: `,
      input: candidate.input,
      output: candidate.output,
      signalEmitter: new EventEmitter()
    });
    stop(candidate.input);
    await assert.rejects(reading, message);
    assert.equal(candidate.input.isRaw, false);
    assert.doesNotMatch(candidate.writes.join(""), /secret/);
  }
});

test("secure token input restores prior raw and paused state and applies backspace", async () => {
  const candidate = terminal({ raw: true, paused: true });
  const reading = readSecretInput({
    input: candidate.input,
    output: candidate.output,
    signalEmitter: new EventEmitter()
  });
  candidate.input.emit("data", "abc\u007fD\r");
  assert.equal(await reading, "abD");
  assert.equal(candidate.input.isRaw, true);
  assert.equal(candidate.isPaused(), true);
  assert.doesNotMatch(candidate.writes.join(""), /abD|abc/);
});

test("SIGTERM restores the terminal before forwarding termination", async () => {
  const candidate = terminal({ paused: true });
  const signals = new EventEmitter();
  const forwarded = [];
  const reading = readSecretInput({
    input: candidate.input,
    output: candidate.output,
    signalEmitter: signals,
    onTerminationSignal: (signal) => {
      forwarded.push({ signal, raw: candidate.input.isRaw, paused: candidate.isPaused() });
    }
  });
  signals.emit("SIGTERM");
  await assert.rejects(reading, /terminated/i);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(forwarded, [{ signal: "SIGTERM", raw: false, paused: true }]);
});
