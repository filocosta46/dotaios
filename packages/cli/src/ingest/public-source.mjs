import { isIP } from "node:net";
import { lookup as lookupHost } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120000;

/** Synchronous URL qualification; fetchPublicSource also qualifies DNS and redirects. */
export function assertPublicSourceUrl(rawUrl) {
  let url;
  try {
    if (typeof rawUrl !== "string" || rawUrl.length > 4096
      || /[\u0000-\u0020\u007f\\]/.test(rawUrl) || !/^https?:\/\//i.test(rawUrl)) {
      throw new TypeError("Invalid HTTP URL");
    }
    url = new URL(rawUrl);
    const authority = rawUrl.slice(rawUrl.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    if (url.username || url.password || authority.includes("@")) throw new TypeError("Credentials are unsupported");
  } catch {
    throw sourceError("URL_INVALID", "Public source URL is invalid.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw sourceError("URL_UNSAFE", "Public source must have a public destination.");
  }
  return url;
}

/** Fetch one qualified public text source without using ambient proxy or cookie state. */
export async function fetchPublicSource(rawUrl, { timeoutMs = 10000, maxBytes = MAX_BYTES } = {}, dependencies = {}) {
  const url = assertPublicSourceUrl(rawUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw sourceError("OPTIONS_INVALID", "Public source limits must be positive integers within 120 seconds and 2 MiB.");
  }
  const controller = new AbortController();
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = sourceError("TIMEOUT", "Public source exceeded its deadline.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([followSource(url, maxBytes, dependencies, controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

async function followSource(url, maxBytes, dependencies, signal) {
  const requestedUrl = url.href;
  const request = dependencies.request || ((target, options, callback) =>
    (target.protocol === "https:" ? https : http).request(target, options, callback));
  for (let redirects = 0; ; redirects += 1) {
    url.hash = "";
    const address = await qualifyAddress(url, dependencies.lookup || lookupHost);
    signal.throwIfAborted();
    const response = await requestSource(url, address, request, maxBytes, signal);
    if (!Object.hasOwn(response, "location")) return { url: url.href, requestedUrl, ...response };
    if (redirects === 5) throw sourceError("REDIRECT_LIMIT", "Public source exceeded five redirects.");
    try {
      if (typeof response.location !== "string" || !response.location || response.location.length > 4096
        || /[\u0000-\u0020\u007f\\]/.test(response.location)
        || /^(?:https?:)?\/\/[^/?#]*@/i.test(response.location)) throw new TypeError("Invalid location");
      url = assertPublicSourceUrl(new URL(response.location, url).href);
    } catch (error) {
      if (error.code?.startsWith("DOTAIOS_PUBLIC_SOURCE_")) throw error;
      throw sourceError("URL_INVALID", "Public source redirect URL is invalid.");
    }
  }
}

async function qualifyAddress(url, lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw sourceError("DNS_FAILED", "Public source hostname could not be resolved.");
  }
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 64
    || answers.some((answer) => !answer || !isIP(answer.address) || isIP(answer.address) !== answer.family)) {
    throw sourceError("DNS_FAILED", "Public source hostname has no bounded address result.");
  }
  if (answers.some((answer) => !isPublicAddress(answer.address))) {
    throw sourceError("URL_UNSAFE", "Public source DNS includes a non-public destination.");
  }
  const chosen = answers.find((answer) => answer.family === 4) || answers[0];
  return { address: chosen.address, family: chosen.family };
}

function requestSource(url, address, request, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    let operation;
    let incoming;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) {
        incoming?.destroy();
        operation?.destroy();
        reject(error);
      } else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      operation = request(url, {
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: { accept: "text/html, application/xhtml+xml, text/plain", "accept-encoding": "identity" }
      }, (response) => {
        incoming = response;
        response.once("error", () => finish(sourceError("FETCH_FAILED", "Public source response could not be read.")));
        if (settled) { response.destroy(); return; }
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          finish(null, { location: response.headers.location });
          return;
        }
        const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        const encoding = String(response.headers["content-encoding"] || "identity").trim().toLowerCase();
        const lengthHeader = response.headers["content-length"];
        const expectedBytes = lengthHeader === undefined ? null : Number(lengthHeader);
        let failure;
        if (response.statusCode !== 200) failure = sourceError("HTTP_STATUS", "Public source did not return a complete successful response.");
        else if (!["text/plain", "text/html", "application/xhtml+xml"].includes(contentType)) {
          failure = sourceError("CONTENT_TYPE", "Public source must be HTML or plain text.");
        } else if (encoding !== "identity") {
          failure = sourceError("CONTENT_ENCODING", "Compressed public source responses are unsupported.");
        } else if (expectedBytes !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(expectedBytes))) {
          failure = sourceError("INCOMPLETE", "Public source has an invalid content length.");
        } else if (expectedBytes > maxBytes) {
          failure = sourceError("TOO_LARGE", "Public source exceeds the byte limit.");
        }
        if (failure) {
          finish(failure);
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) {
            finish(sourceError("TOO_LARGE", "Public source exceeds the byte limit."));
          } else chunks.push(Buffer.from(chunk));
        });
        response.once("aborted", () => finish(sourceError("INCOMPLETE", "Public source response was interrupted.")));
        response.once("close", () => {
          if (!settled) finish(sourceError("INCOMPLETE", "Public source response closed before completion."));
        });
        response.once("end", () => {
          if (!response.complete || (expectedBytes !== null && expectedBytes !== bytes)) {
            finish(sourceError("INCOMPLETE", "Public source response ended before its body was complete."));
          } else finish(null, { contentType, body: Buffer.concat(chunks, bytes) });
        });
      });
      operation.once("error", () => finish(sourceError("FETCH_FAILED", "Public source request failed.")));
      operation.end();
    } catch {
      finish(sourceError("FETCH_FAILED", "Public source request failed."));
    }
  });
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const parts = address.split(":");
  const first = parseInt(parts[0] || "0", 16);
  const second = parseInt(parts[1] || "0", 16);
  // Conservative public-web policy: ordinary global unicast only, excluding
  // IANA special-purpose/transition ranges, including both documentation blocks.
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && first !== 0x2002
    && !(first === 0x3fff && second < 0x1000);
}

function sourceError(reason, message) {
  const error = new Error(message);
  error.code = `DOTAIOS_PUBLIC_SOURCE_${reason}`;
  return error;
}
