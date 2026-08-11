import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionCodecError,
  compareTurnSequences,
  deriveProjectionRows,
  deriveProjectionRow,
  parseSessionMarkdown,
  renderSessionMarkdown,
} from "../../packages/core/src/session-codec.mjs";

const SESSION = Object.freeze({
  schema: 1,
  agent: "claude-code",
  session_id: "a1b2c3d4",
  captured_at: "2026-08-11T09:10:11.000Z",
  source_type: "claude-code",
  source_path: "/Users/example/.claude/projects/demo/session.jsonl",
  project: "demo",
  project_id: "prj_01hxyz",
  turns: [
    { role: "user", ts: "2026-08-11T09:10:11.000Z", content: "Ship the codec." },
    { role: "assistant", ts: "2026-08-11T09:10:12.000Z", content: "Working on it." },
  ],
  title: "Ship the codec",
});

test("schema-1 Markdown round-trips and derives one deterministic projection row", () => {
  const markdown = renderSessionMarkdown(SESSION);
  const parsed = parseSessionMarkdown(Buffer.from(markdown, "utf8"));

  assert.deepEqual(parsed, {
    ...SESSION,
    turns: [
      { role: "user", ts: "09:10", content: "Ship the codec." },
      { role: "assistant", ts: "09:10", content: "Working on it." },
    ],
  });
  assert.equal(renderSessionMarkdown(parsed), markdown);
  assert.deepEqual(
    deriveProjectionRow(parsed, "memory/sessions/2026-08-11/record.md"),
    {
      session_id: "a1b2c3d4",
      agent: "claude-code",
      captured_at: "2026-08-11T09:10:11.000Z",
      source_type: "claude-code",
      source_path: "/Users/example/.claude/projects/demo/session.jsonl",
      project: "demo",
      project_id: "prj_01hxyz",
      turns: 2,
      title: "Ship the codec",
      path: "memory/sessions/2026-08-11/record.md",
      content_hash: "ae606d9d956a4a8a",
    },
  );
});

test("an omitted title stays null instead of becoming a new canonical fact", () => {
  const markdown = [
    "---",
    "agent: manual",
    "session_id: abcdef12",
    "captured_at: 2026-08-11T09:10:11.000Z",
    "source_type: import",
    "turns: 1",
    "schema: 1",
    "---",
    "",
    "**user**",
    "",
    "An untitled session",
    "",
  ].join("\n");

  const parsed = parseSessionMarkdown(markdown);

  assert.equal(parsed.title, null);
  assert.doesNotMatch(renderSessionMarkdown(parsed), /\ntitle:/);
});

test("a turns: 0 prepared summary preserves arbitrary bounded Markdown", () => {
  const body = "# Session summary\n\n## Decisions\n\n- Keep Markdown canonical.\n";
  const markdown = renderSessionMarkdown({
    schema: 1,
    agent: "codex",
    session_id: "0123abcd",
    captured_at: "2026-08-11T11:00:00.000Z",
    source_type: "prepared",
    project: "demo",
    project_id: "prj_01hxyz",
    turns: [],
    body,
    title: "SessionStore design",
  });

  const parsed = parseSessionMarkdown(Buffer.from(markdown));

  assert.equal(parsed.body, body);
  assert.deepEqual(parsed.turns, []);
  assert.equal(renderSessionMarkdown(parsed), markdown);
});

test("capture drafts may omit the store-owned ID while canonical Markdown may not", () => {
  const markdown = [
    "---",
    "agent: codex",
    "captured_at: 2026-08-11T11:00:00.000Z",
    "source_type: prepared",
    "turns: 0",
    "schema: 1",
    "---",
    "",
    "Prepared without a caller-owned identifier.",
  ].join("\n");

  assert.throws(
    () => parseSessionMarkdown(markdown),
    { code: "DOTAIOS_SESSION_FRONTMATTER_REQUIRED" },
  );
  assert.equal(
    parseSessionMarkdown(markdown, { allowMissingSessionId: true }).session_id,
    "capture-candidate",
  );
});

test("frontmatter is a closed required scalar schema", () => {
  const documents = [
    "agent: manual\nagent: codex\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: import\nturns: 0\nschema: 1",
    "agent: &agent manual\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: *agent\nturns: 0\nschema: 1",
    "agent: !unsafe manual\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: import\nturns: 0\nschema: 1",
    "agent: [manual]\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: import\nturns: 0\nschema: 1",
    "agent: manual\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: import\nturns: 0\nschema: 1\n__proto__: unsafe",
    "agent: manual\nsession_id: abcdef12\ncaptured_at: 2026-08-11T09:10:11.000Z\nsource_type: import\nturns: 0",
  ];

  for (const frontmatter of documents) {
    assert.throws(
      () => parseSessionMarkdown(`---\n${frontmatter}\n---\n\n`),
      (error) => error instanceof SessionCodecError,
      frontmatter,
    );
  }
});

test("projection derivation sorts records and marks every conflicting source member", () => {
  const sourcePath = "/Users/example/.claude/projects/demo/session.jsonl";
  const second = {
    ...SESSION,
    session_id: "bbbb2222",
    captured_at: "2026-08-11T10:00:00.000Z",
    turns: [{ role: "user", content: "Diverged" }],
  };
  const first = {
    ...SESSION,
    session_id: "aaaa1111",
    captured_at: "2026-08-11T09:00:00.000Z",
  };
  const unsourced = {
    ...SESSION,
    session_id: "cccc3333",
    captured_at: "2026-08-11T08:00:00.000Z",
    source_path: undefined,
  };

  const rows = deriveProjectionRows([
    { session: second, relativePath: "memory/sessions/2026-08-11/second.md" },
    { session: first, relativePath: "memory/sessions/2026-08-11/first.md" },
    { session: unsourced, relativePath: "memory/sessions/2026-08-11/unsourced.md" },
  ]);

  assert.deepEqual(rows.map((row) => row.session_id), ["cccc3333", "aaaa1111", "bbbb2222"]);
  assert.equal(rows[0].conflict_group, undefined);
  assert.match(rows[1].conflict_group, /^source-[0-9a-f]{16}$/);
  assert.equal(rows[2].conflict_group, rows[1].conflict_group);
  assert.equal(rows[1].conflict_of, undefined);
  assert.equal(rows[2].conflict_of, "aaaa1111");
  assert.equal(compareTurnSequences(first, second), "divergent");
  assert.equal(sourcePath, first.source_path);
});

test("projection derivation refuses absolute, traversal, backslash, and control paths", () => {
  for (const candidate of [
    "/memory/sessions/2026-08-11/record.md",
    "memory/sessions/../record.md",
    "memory\\sessions\\2026-08-11\\record.md",
    "memory/sessions/2026-08-11/bad\u0000.md",
  ]) {
    assert.throws(
      () => deriveProjectionRow(SESSION, candidate),
      (error) => error instanceof SessionCodecError && error.code === "DOTAIOS_SESSION_PATH_INVALID",
    );
  }
});

test("turn comparison implements the complete prefix table without using timestamps", () => {
  const base = {
    ...SESSION,
    turns: [{ role: "user", ts: "09:10", content: "one" }],
  };
  const sameAtAnotherInstant = {
    ...base,
    turns: [{ role: "user", ts: "10:22", content: "one" }],
  };
  const longer = {
    ...base,
    turns: [...base.turns, { role: "assistant", content: "two" }],
  };
  const branch = {
    ...base,
    turns: [{ role: "user", content: "different" }],
  };

  assert.equal(compareTurnSequences(base, sameAtAnotherInstant), "equal");
  assert.equal(compareTurnSequences(base, longer), "existing_prefix");
  assert.equal(compareTurnSequences(longer, base), "candidate_prefix");
  assert.equal(compareTurnSequences(base, branch), "divergent");
});

test("empty and newline-bearing turn content round-trips without inventing bytes", () => {
  const session = {
    ...SESSION,
    turns: [
      { role: "user", content: "" },
      { role: "assistant", content: "line one\n\nline two\n" },
      { role: "user", content: "" },
    ],
  };

  const parsed = parseSessionMarkdown(renderSessionMarkdown(session));

  assert.deepEqual(parsed.turns, session.turns);
});

test("schema-1 turn bodies preserve standalone role delimiters as content", () => {
  const session = {
    ...SESSION,
    turns: [
      {
        role: "user",
        content: [
          "A literal marker follows:",
          "**assistant**",
          "**tool-result · 23:59**",
          "**user · arbitrary legacy label**",
        ].join("\n"),
      },
      { role: "assistant", content: "Those lines are content, not turns." },
    ],
  };

  const markdown = renderSessionMarkdown(session);
  const parsed = parseSessionMarkdown(markdown);

  assert.match(markdown, /\nbody_encoding: escaped-lines-v1\n/);
  assert.match(markdown, /\n\\\*\*assistant\*\*\n/);
  assert.deepEqual(parsed.turns, session.turns);
});

test("schema-1 turn body escaping is collision-free for leading escape markers", () => {
  const session = {
    ...SESSION,
    turns: [
      {
        role: "user",
        content: [
          "\\",
          "\\leading escape",
          "\\**assistant**",
          "\\\\**assistant · 09:10**",
          "ordinary \\ text",
        ].join("\n"),
      },
      { role: "assistant", content: "done" },
    ],
  };

  const markdown = renderSessionMarkdown(session);
  const parsed = parseSessionMarkdown(markdown);

  assert.match(markdown, /\nbody_encoding: escaped-lines-v1\n/);
  assert.deepEqual(parsed.turns, session.turns);
  assert.equal(renderSessionMarkdown(parsed), markdown);
  assert.throws(
    () => parseSessionMarkdown(markdown.replace("\\\\leading escape", "\\leading escape")),
    (error) => error instanceof SessionCodecError && error.code === "DOTAIOS_SESSION_BODY_INVALID",
  );
});

test("invalid UTF-8, formats, controls, counts, and byte bounds refuse before derivation", () => {
  const wrap = (frontmatter, body = "") => `---\n${frontmatter}\n---\n\n${body}`;
  const valid = [
    "agent: manual",
    "session_id: abcdef12",
    "captured_at: 2026-08-11T09:10:11.000Z",
    "source_type: import",
    "turns: 0",
    "schema: 1",
  ];
  const cases = [
    Buffer.from([0xff, 0xfe, 0xfd]),
    wrap(valid.map((line) => line.replace("session_id: abcdef12", "session_id: ../escape")).join("\n")),
    wrap(valid.map((line) => line.replace("captured_at: 2026-08-11T09:10:11.000Z", "captured_at: yesterday")).join("\n")),
    wrap([...valid, "project: Demo Project"].join("\n")),
    wrap([...valid, `title: "${"x".repeat(513)}"`].join("\n")),
    wrap([...valid, "title: null"].join("\n")),
    wrap([...valid, "title: \"line\\nbreak\""].join("\n")),
    wrap(valid.map((line) => line.replace("turns: 0", "turns: 10001")).join("\n")),
    wrap(valid.map((line) => line.replace("source_type: import", "source_type: \"bad\\u0001value\"")).join("\n")),
    wrap(valid.map((line) => line.replace("turns: 0", "turns: 1")).join("\n"), "not a turn"),
    wrap(valid.map((line) => line.replace("turns: 0", "turns: 1")).join("\n"), "**user · 99:99**\n\ninvalid time\n"),
    wrap(valid.join("\n"), "x".repeat(1024 * 1024 + 1)),
    wrap(valid.map((line) => line.replace("session_id: abcdef12", `session_id: ${"x".repeat(17 * 1024)}`)).join("\n")),
  ];

  for (const input of cases) {
    assert.throws(
      () => parseSessionMarkdown(input),
      (error) => error instanceof SessionCodecError && /^DOTAIOS_SESSION_/.test(error.code),
    );
  }

  assert.throws(
    () => renderSessionMarkdown({ ...SESSION, turns: "not-an-array" }),
    (error) => error instanceof SessionCodecError && error.code === "DOTAIOS_SESSION_TURNS_INVALID",
  );
});
