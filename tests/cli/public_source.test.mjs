import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { assertPublicSourceUrl, fetchPublicSource } from "../../packages/cli/src/ingest/public-source.mjs";

test("public source URLs refuse private and reserved literal destinations", () => {
  for (const host of [
    "localhost", "notes.localhost.", "127.0.0.1", "2130706433", "0x7f000001",
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.31.0.1",
    "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "[fc00::1]",
    "[fe80::1]", "[64:ff9b::a00:1]", "[2001:db8::1]", "[2002:a00:1::1]", "[3fff::1]"
  ]) {
    assert.throws(() => assertPublicSourceUrl(`http://${host}/source`),
      { code: "DOTAIOS_PUBLIC_SOURCE_URL_UNSAFE" }, host);
  }
});

test("public source URLs require explicit HTTP or HTTPS without credentials or controls", () => {
  for (const input of [
    "file:///etc/hosts", "ftp://example.org/research", "https://name:secret@example.org/",
    "https://@example.org/", "https://example.org/\nextra", "https://example.org\\secret", null, {}
  ]) {
    assert.throws(() => assertPublicSourceUrl(input), { code: "DOTAIOS_PUBLIC_SOURCE_URL_INVALID" });
  }
  assert.equal(assertPublicSourceUrl("https://example.org/notes#section").href, "https://example.org/notes#section");
  assert.equal(assertPublicSourceUrl("http://8.8.8.8/").hostname, "8.8.8.8");
  assert.equal(assertPublicSourceUrl("https://[2606:4700:4700::1111]/").protocol, "https:");
});

function networkFixture(responses = [{ body: [Buffer.from("Research evidence.")] }]) {
  const calls = [];
  const request = (url, options, onResponse) => {
    const call = { url, options, request: new EventEmitter(), response: null };
    calls.push(call);
    call.request.end = () => queueMicrotask(async () => {
      const fixture = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (fixture.delayMs) await delay(fixture.delayMs);
      call.response = fixture.stream || Readable.from(fixture.body || []);
      Object.assign(call.response, {
        statusCode: fixture.statusCode || 200,
        headers: fixture.headers || { "content-type": "text/plain; charset=utf-8" },
        complete: fixture.complete ?? true
      });
      onResponse(call.response);
    });
    call.request.destroy = () => { call.destroyed = true; call.response?.destroy(); };
    return call.request;
  };
  return { calls, request };
}

test("public fetch validates every DNS answer and pins the socket lookup to a qualified address", async () => {
  const network = networkFixture();
  const lookup = async (hostname, options) => {
    assert.equal(hostname, "example.org");
    assert.equal(options.all, true);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const result = await fetchPublicSource("https://example.org/notes#section", {}, { lookup, request: network.request });
  assert.deepEqual(result, {
    requestedUrl: "https://example.org/notes#section", url: "https://example.org/notes",
    contentType: "text/plain", body: Buffer.from("Research evidence.")
  });
  assert.equal(network.calls[0].url.hostname, "example.org", "HTTP Host and TLS identity retain the original hostname");
  assert.equal(network.calls[0].options.agent, false, "a reused socket cannot bypass this request's qualification");
  assert.equal(network.calls[0].options.rejectUnauthorized, true, "HTTPS verification does not inherit a disabled host default");
  for (const all of [false, true]) {
    const answer = await new Promise((resolve, reject) => network.calls[0].options.lookup("example.org", { all },
      (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(answer, all
      ? { address: [{ address: "93.184.216.34", family: 4 }], family: undefined }
      : { address: "93.184.216.34", family: 4 });
  }

  const refused = networkFixture();
  await assert.rejects(fetchPublicSource("https://example.org/", {}, {
    request: refused.request,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]
  }), { code: "DOTAIOS_PUBLIC_SOURCE_URL_UNSAFE" });
  assert.equal(refused.calls.length, 0, "mixed public/private DNS must not dispatch a request");
});

test("one public fetch deadline covers DNS, redirects, and a stalled body", { timeout: 2000 }, async () => {
  const answer = [{ address: "93.184.216.34", family: 4 }];
  const dnsNetwork = networkFixture();
  await assert.rejects(fetchPublicSource("https://example.org/", { timeoutMs: 15 }, {
    lookup: async () => { await delay(50); return answer; }, request: dnsNetwork.request
  }), { code: "DOTAIOS_PUBLIC_SOURCE_TIMEOUT" });
  await delay(60);
  assert.equal(dnsNetwork.calls.length, 0, "late DNS completion must not start an abandoned request");

  const redirects = networkFixture([
    { delayMs: 35, statusCode: 302, headers: { location: "/final" } },
    { delayMs: 35, body: ["Too late"] }
  ]);
  await assert.rejects(fetchPublicSource("https://example.org/", { timeoutMs: 50 }, {
    lookup: async () => answer, request: redirects.request
  }), { code: "DOTAIOS_PUBLIC_SOURCE_TIMEOUT" });
  assert.equal(redirects.calls.at(-1).destroyed, true, "expiry closes the outstanding request");

  const stream = new Readable({ read() {} });
  const bodyNetwork = networkFixture([{ stream }]);
  const close = setTimeout(() => stream.push(null), 60);
  try {
    await assert.rejects(fetchPublicSource("https://example.org/", { timeoutMs: 15 }, {
      lookup: async () => answer, request: bodyNetwork.request
    }), { code: "DOTAIOS_PUBLIC_SOURCE_TIMEOUT" });
    assert.equal(stream.destroyed, true, "expiry closes a stalled response");
  } finally { clearTimeout(close); }
});

test("public fetch bounds actual streamed bytes and refuses incomplete or inconsistent bodies", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const [fixture, code] of [
    [{ headers: { "content-type": "text/plain", "content-length": "6" }, body: ["123456"] }, "TOO_LARGE"],
    [{ body: ["123", "456"] }, "TOO_LARGE"],
    [{ headers: { "content-type": "text/plain", "content-length": "5" }, body: ["123"] }, "INCOMPLETE"],
    [{ headers: { "content-type": "text/plain", "content-length": "invalid" }, body: ["123"] }, "INCOMPLETE"],
    [{ body: ["123"], complete: false }, "INCOMPLETE"]
  ]) {
    const network = networkFixture([fixture]);
    await assert.rejects(fetchPublicSource("https://example.org/", { maxBytes: 5 }, { lookup, request: network.request }),
      { code: `DOTAIOS_PUBLIC_SOURCE_${code}` });
    assert.equal(network.calls[0].response.destroyed, true);
  }
  const exact = networkFixture([{ body: ["12", "345"] }]);
  const result = await fetchPublicSource("https://example.org/", { maxBytes: 5 }, { lookup, request: exact.request });
  assert.equal(result.body.toString(), "12345");
});

test("public fetch requalifies redirect destinations and stops after five hops", async () => {
  const network = networkFixture([
    { statusCode: 302, headers: { location: "https://research.example.org/final" } },
    { headers: { "content-type": "text/html" }, body: [Buffer.from("<p>Final evidence</p>")] }
  ]);
  const hosts = [];
  const lookup = async (hostname) => { hosts.push(hostname); return [{ address: "93.184.216.34", family: 4 }]; };
  const result = await fetchPublicSource("https://example.org/start", {}, { lookup, request: network.request });
  assert.equal(result.url, "https://research.example.org/final");
  assert.equal(result.requestedUrl, "https://example.org/start");
  assert.deepEqual(hosts, ["example.org", "research.example.org"]);
  assert.equal(network.calls[0].response.destroyed, true, "redirect bodies are closed without collecting them");

  for (const location of ["http://127.0.0.1/private", "https://name:secret@example.org/", "https://private.example.org/"]) {
    const denied = networkFixture([{ statusCode: 307, headers: { location } }]);
    await assert.rejects(fetchPublicSource("https://example.org/", {}, {
      request: denied.request,
      lookup: async (hostname) => [{ address: hostname === "private.example.org" ? "10.0.0.1" : "93.184.216.34", family: 4 }]
    }), (error) => ["DOTAIOS_PUBLIC_SOURCE_URL_UNSAFE", "DOTAIOS_PUBLIC_SOURCE_URL_INVALID"].includes(error.code));
    assert.equal(denied.calls.length, 1, "an unsafe redirect never reaches the next request");
  }
  const loop = networkFixture([{ statusCode: 301, headers: { location: "/again" } }]);
  await assert.rejects(fetchPublicSource("https://example.org/", {}, { lookup, request: loop.request }),
    { code: "DOTAIOS_PUBLIC_SOURCE_REDIRECT_LIMIT" });
  assert.equal(loop.calls.length, 6);
});

test("public fetch accepts complete text responses and refuses unsupported status, type, or encoding", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const contentType of ["text/plain", "text/html", "application/xhtml+xml"]) {
    const network = networkFixture([{ headers: { "content-type": `${contentType}; charset=utf-8` }, body: ["Evidence"] }]);
    const result = await fetchPublicSource("https://example.org/", {}, { lookup, request: network.request });
    assert.equal(result.contentType, contentType);
  }
  for (const [fixture, code] of [
    [{ statusCode: 404 }, "HTTP_STATUS"],
    [{ statusCode: 206 }, "HTTP_STATUS"],
    [{ headers: { "content-type": "application/pdf" } }, "CONTENT_TYPE"],
    [{ headers: {} }, "CONTENT_TYPE"],
    [{ headers: { "content-type": "text/plain", "content-encoding": "gzip" } }, "CONTENT_ENCODING"],
    [{ headers: { "content-type": "text/plain", "content-encoding": "br" } }, "CONTENT_ENCODING"]
  ]) {
    const network = networkFixture([{ ...fixture, body: ["Must not be retained"] }]);
    await assert.rejects(fetchPublicSource("https://example.org/", {}, { lookup, request: network.request }),
      { code: `DOTAIOS_PUBLIC_SOURCE_${code}` });
    assert.equal(network.calls[0].response.destroyed, true);
  }
});

test("public fetch rejects invalid bounds and malformed redirects before another request", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const options of [
    { maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: 2.5 }, { maxBytes: 2 * 1024 * 1024 + 1 },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: -1 }, { timeoutMs: 120001 }
  ]) {
    const network = networkFixture();
    await assert.rejects(fetchPublicSource("https://example.org/", options, { lookup, request: network.request }),
      { code: "DOTAIOS_PUBLIC_SOURCE_OPTIONS_INVALID" });
    assert.equal(network.calls.length, 0);
  }
  for (const location of [undefined, "", "https://@example.org/", "//name:secret@example.org/", "/line\nbreak", "//example.org\\path", "file:///etc/hosts"]) {
    const network = networkFixture([{ statusCode: 302, headers: { location } }]);
    await assert.rejects(fetchPublicSource("https://example.org/", {}, { lookup, request: network.request }),
      { code: "DOTAIOS_PUBLIC_SOURCE_URL_INVALID" });
    assert.equal(network.calls.length, 1);
  }
});

test("public fetch returns stable errors for DNS and transport failures without retaining partial text", async () => {
  for (const lookup of [async () => [], async () => [null], async () => { throw new Error("Internal DNS details"); }]) {
    const network = networkFixture();
    await assert.rejects(fetchPublicSource("https://example.org/", {}, { lookup, request: network.request }),
      { code: "DOTAIOS_PUBLIC_SOURCE_DNS_FAILED" });
    assert.equal(network.calls.length, 0);
  }
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(fetchPublicSource("https://example.org/", {}, {
    lookup, request: () => { throw new Error("Internal socket details"); }
  }), { code: "DOTAIOS_PUBLIC_SOURCE_FETCH_FAILED", message: "Public source request failed." });
  const stream = new Readable({ read() { this.push("Partial"); this.destroy(); } });
  const network = networkFixture([{ stream }]);
  await assert.rejects(fetchPublicSource("https://example.org/", {}, { lookup, request: network.request }),
    { code: "DOTAIOS_PUBLIC_SOURCE_INCOMPLETE" });
});
