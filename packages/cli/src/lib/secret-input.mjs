import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

export function readSecretInput({
  prompt = "  Paste your token here, then press Enter: ",
  input = defaultInput,
  output = defaultOutput,
  signalEmitter = process,
  abortSignal = null,
  onTerminationSignal = null
} = {}) {
  if (!input?.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error(
      "A secure interactive terminal is required to enter the GitHub token without echo."
    ));
  }

  const priorRaw = Boolean(input.isRaw);
  const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
  const terminate = onTerminationSignal || (
    signalEmitter === process
      ? (signal) => process.kill(process.pid, signal)
      : null
  );

  return new Promise((resolve, reject) => {
    let secret = "";
    let settled = false;

    const restore = () => {
      let firstError = null;
      const attempt = (action) => {
        try { action(); } catch (error) { firstError ||= error; }
      };
      attempt(() => input.off?.("data", onData));
      attempt(() => input.off?.("error", onError));
      attempt(() => input.off?.("end", onEnd));
      attempt(() => signalEmitter.off?.("SIGINT", onInterrupt));
      attempt(() => signalEmitter.off?.("SIGTERM", onTerminate));
      attempt(() => abortSignal?.removeEventListener?.("abort", onAbort));
      attempt(() => input.setRawMode(priorRaw));
      if (wasPaused) attempt(() => input.pause?.());
      if (firstError) throw firstError;
    };

    const finish = (error = null, terminationSignal = null) => {
      if (settled) return;
      settled = true;
      let restoreError = null;
      try { restore(); } catch (caught) { restoreError = caught; }
      let outputError = null;
      try { output.write("\n"); } catch (caught) { outputError = caught; }
      if (error || restoreError || outputError) reject(error || restoreError || outputError);
      else resolve(secret);
      secret = "";
      if (terminationSignal && terminate) {
        queueMicrotask(() => terminate(terminationSignal));
      }
    };

    function onData(chunk) {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Secure token entry was interrupted."));
        if (character === "\u0004") return finish(new Error("Secure token entry was cancelled."));
        if (character === "\u007f" || character === "\b") {
          secret = Array.from(secret).slice(0, -1).join("");
        } else if (character >= " ") {
          secret += character;
        }
      }
    }
    function onError(error) { finish(error); }
    function onEnd() { finish(new Error("Secure token entry ended before Enter was pressed.")); }
    function onInterrupt() { finish(new Error("Secure token entry was interrupted.")); }
    function onTerminate() {
      finish(new Error("Secure token entry was terminated."), "SIGTERM");
    }
    function onAbort() { finish(new Error("Secure token entry was cancelled.")); }

    try {
      input.setEncoding?.("utf8");
      input.setRawMode(true);
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
      signalEmitter.once?.("SIGINT", onInterrupt);
      signalEmitter.once?.("SIGTERM", onTerminate);
      abortSignal?.addEventListener?.("abort", onAbort, { once: true });
      output.write(prompt);
      input.resume?.();
      if (abortSignal?.aborted) onAbort();
    } catch (error) {
      finish(error);
    }
  });
}
