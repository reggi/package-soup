import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../dist/index.js";

function compact(result) {
  return result.packages.map(({ name, specifiers }) => ({ name, specifiers }));
}

test("classifies every atomic reference type in mixed input", () => {
  const input = [
    "lodash",
    "react@18.3.1",
    "zod@^3.23.0",
    'typescript@">=5.5 <6,5.6.3"',
    "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
    "https://www.npmjs.com/package/chalk",
    "https://www.npmjs.com/commander",
  ].join("\n");

  const result = parse(input);

  assert.deepEqual(
    result.atoms.map(({ type }) => type),
    [
      "package",
      "exact-version",
      "semver-range",
      "specifier-list",
      "tarball",
      "npm-page",
      "npm-page",
    ],
  );
  assert.deepEqual(
    result.atoms[3].specifiers.map(({ type }) => type),
    ["semver-range", "exact-version"],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("deduplicates packages and exact specifier spellings in first-seen order", () => {
  const result = parse(
    "react@18.3.1\nlodash\nreact@10.2.3\nreact@18.3.1\nreact@=18.3.1",
  );

  assert.deepEqual(compact(result), [
    {
      name: "react",
      specifiers: ["18.3.1", "10.2.3", "=18.3.1"],
    },
    { name: "lodash", specifiers: [] },
  ]);
  assert.equal(result.packages[0].occurrences.length, 4);
});

test("parses multiple quoted package expressions on one line", () => {
  const result = parse(
    'package@"10.0.0,9.0.2" bpackage@"10.0.0,9.0.2"',
  );

  assert.deepEqual(compact(result), [
    { name: "package", specifiers: ["10.0.0", "9.0.2"] },
    { name: "bpackage", specifiers: ["10.0.0", "9.0.2"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("infers heterogeneous expressions and preserves every valid token", () => {
  const input = [
    "react@18.3.1, lodash",
    "react@^19.0.0, @types/node: >=20 <23",
    'package@"10.0.0,9.0.2", https://www.npmjs.com/package/zod bad package@wat',
  ].join("\n");

  const result = parse(input);

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["18.3.1", "^19.0.0"] },
    { name: "lodash", specifiers: [] },
    { name: "@types/node", specifiers: [">=20 <23"] },
    { name: "package", specifiers: ["10.0.0", "9.0.2", "wat"] },
    { name: "zod", specifiers: [] },
    { name: "bad", specifiers: [] },
  ]);
  assert.deepEqual(
    result.atoms.map(({ type }) => type),
    [
      "exact-version",
      "package",
      "semver-range",
      "semver-range",
      "specifier-list",
      "npm-page",
      "package",
      "dist-tag",
    ],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("parses a whitespace-separated package-only list", () => {
  const result = parse("lodash zod chalk");

  assert.deepEqual(compact(result), [
    { name: "lodash", specifiers: [] },
    { name: "zod", specifiers: [] },
    { name: "chalk", specifiers: [] },
  ]);
});

test("does not swallow a package after an attached specifier", () => {
  const result = parse("react@18.3.1 lodash");

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["18.3.1"] },
    { name: "lodash", specifiers: [] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("parses package-first version columns as a specifier list", () => {
  const result = parse("react 18.3.1 ^19.0.0");

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["18.3.1", "^19.0.0"] },
  ]);
  assert.equal(result.atoms[0].type, "specifier-list");
  assert.deepEqual(
    result.atoms[0].specifiers.map(({ type }) => type),
    ["exact-version", "semver-range"],
  );
});

test("parses valid tokens independently in a mixed whitespace record", () => {
  const result = parse("react@18.3.1\nbad package@wat\nzod ^3.23.0");

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["18.3.1"] },
    { name: "bad", specifiers: [] },
    { name: "package", specifiers: ["wat"] },
    { name: "zod", specifiers: ["^3.23.0"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("retains valid list entries and diagnoses an empty trailing entry", () => {
  const result = parse('lodash@"1.0.0,"');

  assert.equal(result.atoms[0].type, "specifier-list");
  assert.deepEqual(result.atoms[0].specifiers.map(({ value }) => value), [
    "1.0.0",
  ]);
  assert.deepEqual(
    result.diagnostics.map(({ code, span }) => [code, span.text]),
    [["invalid-specifier", ""]],
  );
});

test("parses positional CSV including npm dist-tags", () => {
  const result = parse(
    "react, ^18.2.0, 18.3.1\nlodash, 4.17.21, wat, ^4.17.0",
  );

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["^18.2.0", "18.3.1"] },
    { name: "lodash", specifiers: ["4.17.21", "wat", "^4.17.0"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("parses quoted CSV fields without adding a trailing empty field", () => {
  const result = parse('"react","18.3.1"');

  assert.deepEqual(compact(result), [
    { name: "react", specifiers: ["18.3.1"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("parses npm inventory CSV by header names and skips non-npm rows", () => {
  const input = [
    "Detected,Version,Name,Namespace,Ecosystem,Artifact",
    "2024-01-15T09:41:25.543Z,6.0.0,sample-cli,,npm,",
    "2024-01-15T09:44:25.577Z,1.6.2,docs-kit,@example,npm,",
    "2024-01-15T09:44:25.577Z,2.0.0,sample-python,,pypi,",
  ].join("\r\n");

  const result = parse(input);

  assert.deepEqual(compact(result), [
    { name: "sample-cli", specifiers: ["6.0.0"] },
    { name: "@example/docs-kit", specifiers: ["1.6.2"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("parses Markdown tables and list records", () => {
  const input = [
    "| package | versions |",
    "| --- | --- |",
    "| zod | ^3.23.0, 3.24.1 |",
    "- @types/node: >=20 <23",
    "1. typescript: ~5.6.0",
  ].join("\n");

  const result = parse(input);

  assert.deepEqual(compact(result), [
    { name: "zod", specifiers: ["^3.23.0", "3.24.1"] },
    { name: "@types/node", specifiers: [">=20 <23"] },
    { name: "typescript", specifiers: ["~5.6.0"] },
  ]);
});

test("parses scoped attached references and npm URL identifiers", () => {
  const input = [
    "@scope/pkg@1.2.3",
    "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz",
    "https://registry.npmjs.org/@scope%2Fpkg/-/pkg-3.0.0.tgz",
    "https://www.npmjs.com/package/@scope/pkg",
    "https://www.npmjs.com/@scope%2Fpkg",
  ].join("\n");

  const result = parse(input);

  assert.deepEqual(compact(result), [
    { name: "@scope/pkg", specifiers: ["1.2.3", "2.0.0", "3.0.0"] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("accepts npm page URL suffixes without including them in the package", () => {
  const result = parse(
    "https://www.npmjs.com/package/lodash/?activeTab=versions#readme",
  );

  assert.deepEqual(compact(result), [{ name: "lodash", specifiers: [] }]);
  assert.equal(result.atoms[0].span.text.includes("?activeTab"), true);
  assert.equal(result.atoms[0].packageSpan.text, "lodash");
});

test("classifies non-npm URLs as npm-package-arg remote specs", () => {
  const result = parse(
    [
      "https://npmjs.example/package/lodash",
      "https://registry.npmjs.org/lodash/-/other-1.0.0.tgz",
      "https://www.npmjs.com/search",
    ].join("\n"),
  );

  assert.deepEqual(
    result.atoms.map(({ type }) => type),
    ["remote", "remote", "remote"],
  );
  assert.equal(result.packages.length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("is a superset of npm-package-arg standard spec families", () => {
  const result = parse(
    [
      "lodash@latest",
      "alias@npm:lodash@^4",
      "named-remote@https://example.com/archive.tgz",
      "git+https://github.com/npm/cli.git",
      "file:../local-package",
      "./archive.tgz",
    ].join("\n"),
  );

  assert.deepEqual(
    result.atoms.map(({ type }) => type),
    ["dist-tag", "npm-alias", "remote", "git", "directory", "file"],
  );
  assert.deepEqual(compact(result), [
    { name: "lodash", specifiers: ["latest"] },
    { name: "alias", specifiers: ["npm:lodash@^4"] },
    {
      name: "named-remote",
      specifiers: ["https://example.com/archive.tgz"],
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("treats arbitrary npm dist-tags as valid offline specifiers", () => {
  const result = parse("package@latest\npackage@wat");

  assert.deepEqual(compact(result), [
    { name: "package", specifiers: ["latest", "wat"] },
  ]);
  assert.deepEqual(
    result.atoms.map(({ type }) => type),
    ["dist-tag", "dist-tag"],
  );
});

test("parses resilient mixed input without top-level commas", () => {
  const result = parse(
    'package@"10.0.0,9.0.2" https://www.npmjs.com/package/zod bad package@wat',
  );

  assert.deepEqual(compact(result), [
    { name: "package", specifiers: ["10.0.0", "9.0.2", "wat"] },
    { name: "zod", specifiers: [] },
    { name: "bad", specifiers: [] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("reports malformed quoting", () => {
  const result = parse('lodash@"1.0.0');

  assert.equal(result.atoms.length, 0);
  assert.equal(result.diagnostics[0].code, "malformed-quoting");
});

test("preserves UTF-16 offsets through BOM and CRLF input", () => {
  const input = "\uFEFFreact@18.3.1\r\nlodash@4.17.21";
  const result = parse(input);

  assert.equal(result.atoms[0].span.text, "react@18.3.1");
  assert.equal(result.atoms[0].span.start, 1);
  assert.equal(result.atoms[1].span.start, input.indexOf("lodash"));
  for (const atom of result.atoms) {
    assert.equal(input.slice(atom.span.start, atom.span.end), atom.span.text);
  }
});

test("is synchronous and does not call fetch", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is forbidden");
  };
  try {
    const result = parse("https://www.npmjs.com/package/lodash");
    assert.equal(typeof result.then, "undefined");
    assert.equal(result.packages[0].name, "lodash");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("associates semver versions after a scoped package name on the same line", () => {
  const input = [
    "npm",
    "@example/tool-linux-musl-x64 1.0.74",
    "2024-01-15 09:12:03 UTC\t2024-01-15 09:17:14 UTC",
    "npm",
    "@example/tool-win32-x64 1.0.74",
    "2024-01-15 09:11:59 UTC\t2024-01-15 09:17:11 UTC",
    "@example/tool-linux-x64 1.0.74",
    "@example/tool-darwin-arm64 1.0.74",
  ].join("\n");

  const result = parse(input);

  assert.deepEqual(
    result.packages
      .filter((p) => p.name.startsWith("@example/"))
      .map(({ name, specifiers }) => ({ name, specifiers })),
    [
      { name: "@example/tool-linux-musl-x64", specifiers: ["1.0.74"] },
      { name: "@example/tool-win32-x64", specifiers: ["1.0.74"] },
      { name: "@example/tool-linux-x64", specifiers: ["1.0.74"] },
      { name: "@example/tool-darwin-arm64", specifiers: ["1.0.74"] },
    ],
  );
});

test("associates multiple semver versions after an unscoped package name", () => {
  const result = parse("sample-tool 4.17.21 4.17.20");

  assert.deepEqual(compact(result), [
    { name: "sample-tool", specifiers: ["4.17.21", "4.17.20"] },
  ]);
  assert.equal(result.atoms[0].type, "specifier-list");
});

test("handles large adversarial input without recursive parsing", () => {
  const input = Array.from(
    { length: 5_000 },
    (_, index) => `pkg-${index}@1.0.${index}`,
  ).join("\n");

  const result = parse(input);
  assert.equal(result.atoms.length, 5_000);
  assert.equal(result.diagnostics.length, 0);
});
