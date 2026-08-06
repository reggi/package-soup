import assert from "node:assert/strict";
import test from "node:test";

import {
  format,
  getFormatCompatibility,
  getFormatSelection,
  parse,
} from "../dist/index.js";

const packages = parse(
  "react@18.3.1\nreact@^19.0.0\nlodash\n@scope/pkg@2.0.0",
).packages;

test("formats consolidated and repeated JSON", () => {
  assert.deepEqual(JSON.parse(format(packages, "json-consolidated")), [
    { name: "react", specifiers: ["18.3.1", "^19.0.0"] },
    { name: "lodash", specifiers: [] },
    { name: "@scope/pkg", specifiers: ["2.0.0"] },
  ]);
  assert.deepEqual(JSON.parse(format(packages, "json-repeated")), [
    { name: "react", specifier: "18.3.1" },
    { name: "react", specifier: "^19.0.0" },
    { name: "lodash" },
    { name: "@scope/pkg", specifier: "2.0.0" },
  ]);
});

test("formats CSV variants with valid quoting", () => {
  assert.equal(
    format(packages, "csv-consolidated"),
    [
      "package,specifiers",
      'react,"18.3.1,^19.0.0"',
      "lodash,",
      "@scope/pkg,2.0.0",
    ].join("\n"),
  );
  assert.equal(
    format(packages, "csv-repeated"),
    [
      "package,specifier",
      "react,18.3.1",
      "react,^19.0.0",
      "lodash,",
      "@scope/pkg,2.0.0",
    ].join("\n"),
  );
});

test("formats Markdown variants and escapes range pipes", () => {
  const withOrRange = parse("react@^18 || ^19").packages;
  assert.match(
    format(withOrRange, "markdown-consolidated"),
    /react \| \^18 \\\|\\\| \^19/u,
  );
  assert.match(format(packages, "markdown-repeated"), /react \| 18\.3\.1/u);
});

test("formats newline and space variants", () => {
  assert.equal(
    format(packages, "newline-consolidated"),
    [
      "@scope/pkg@2.0.0",
      "lodash",
      'react@"18.3.1,^19.0.0"',
    ].join("\n"),
  );
  assert.equal(
    format(packages, "space-repeated"),
    "react@18.3.1 react@^19.0.0 lodash @scope/pkg@2.0.0",
  );
});

test("composes package-first column and attached-list text formats", () => {
  const react = parse("react@18.3.1\nreact@^19.9.9").packages;

  assert.equal(
    format(react, {
      output: "text",
      grouping: "consolidated",
      textStyle: "columns",
      recordSeparator: "newline",
      specifierSeparator: "space",
    }),
    "react 18.3.1 ^19.9.9",
  );
  assert.equal(
    format(react, {
      output: "text",
      grouping: "consolidated",
      textStyle: "attached",
    }),
    'react@"18.3.1,^19.9.9"',
  );
});

test("rejects ambiguous space-separated package-first records", () => {
  const options = {
    output: "text",
    grouping: "repeated",
    textStyle: "columns",
    recordSeparator: "space",
    specifierSeparator: "space",
  };

  assert.equal(getFormatCompatibility(packages, options).supported, false);
  assert.throws(() => format(packages, options));
});

test("round trips normalized data through newline and space presets", () => {
  const sortedPackages = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  for (const preset of [
    "newline-consolidated",
    "newline-repeated",
    "space-consolidated",
    "space-repeated",
  ]) {
    const reparsed = parse(format(packages, preset));
    const isNewline = preset.startsWith("newline");
    assert.deepEqual(
      reparsed.packages.map(({ name, specifiers }) => ({ name, specifiers })),
      (isNewline ? sortedPackages : packages).map(({ name, specifiers }) => ({ name, specifiers })),
      preset,
    );
  }
});

test("round trips space-only package output", () => {
  const packageOnly = parse("lodash\nzod").packages;
  for (const preset of ["space-consolidated", "space-repeated"]) {
    assert.equal(getFormatCompatibility(packageOnly, preset).supported, true);
    const reparsed = parse(format(packageOnly, preset));
    assert.deepEqual(
      reparsed.packages.map(({ name, specifiers }) => ({ name, specifiers })),
      packageOnly.map(({ name, specifiers }) => ({ name, specifiers })),
    );
  }
});

test("formats filtered exact versions as npm tarball URLs", () => {
  assert.equal(
    format(packages, {
      output: "tarball",
      filter: {
        semverRanges: false,
        packageOnly: false,
      },
    }),
    [
      "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
      "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz",
    ].join("\n"),
  );
});

test("normalizes exact version spellings in npm tarball URLs", () => {
  const exactVersions = parse("semver@v7.7.2\nsemver@=7.7.1").packages;

  assert.equal(
    format(exactVersions, "tarball-newline"),
    [
      "https://registry.npmjs.org/semver/-/semver-7.7.2.tgz",
      "https://registry.npmjs.org/semver/-/semver-7.7.1.tgz",
    ].join("\n"),
  );
});

test("filters exact versions, ranges, dist-tags, and package-only entries", () => {
  const filterable = parse(
    "exact@1.2.3\nrange@^2.0.0\ntagged@latest\nbare",
  ).packages;
  const output = format(filterable, {
    output: "json",
    filter: {
      exactVersions: true,
      semverRanges: false,
      distTags: true,
      packageOnly: false,
    },
  });

  assert.deepEqual(JSON.parse(output), [
    { name: "exact", specifiers: ["1.2.3"] },
    { name: "tagged", specifiers: ["latest"] },
  ]);
});

test("reports every entry excluded by category filters", () => {
  const filterable = parse(
    "exact@1.2.3\nrange@^2.0.0\ntagged@latest\nbare",
  ).packages;
  const selection = getFormatSelection(filterable, {
    exactVersions: true,
    semverRanges: false,
    distTags: false,
    packageOnly: false,
  });

  assert.deepEqual(
    selection.included.map(({ name, specifiers }) => ({ name, specifiers })),
    [{ name: "exact", specifiers: ["1.2.3"] }],
  );
  assert.deepEqual(selection.excluded, [
    { name: "range", specifier: "^2.0.0", category: "semver-range" },
    { name: "tagged", specifier: "latest", category: "dist-tag" },
    { name: "bare", category: "package-only" },
  ]);
});

test("formats every package as a bare name in names-only mode", () => {
  const mixed = parse(
    "react@18.3.1\nreact@^19.0.0\nreact@latest\nlodash",
  ).packages;

  assert.equal(
    format(mixed, {
      output: "text",
      textStyle: "attached",
      recordSeparator: "newline",
      specifierMode: "names-only",
      filter: {
        exactVersions: false,
        semverRanges: false,
        distTags: false,
        packageOnly: false,
      },
    }),
    "lodash\nreact",
  );
});

test("round trips every supported formatter permutation", () => {
  const matrixPackages = parse(
    "react@18.3.1\nreact@^19.0.0\nreact@latest\nlodash",
  ).packages;
  const outputs = ["json", "csv", "markdown", "text", "tarball"];
  const groupings = ["consolidated", "repeated"];
  const textStyles = ["attached", "columns"];
  const recordSeparators = ["newline", "space"];
  const specifierSeparators = ["space", "comma"];

  for (const specifierMode of ["include", "names-only"]) {
    for (let mask = 0; mask < 16; mask += 1) {
      const filter = {
        exactVersions: Boolean(mask & 1),
        semverRanges: Boolean(mask & 2),
        distTags: Boolean(mask & 4),
        packageOnly: Boolean(mask & 8),
      };
      const expected = JSON.parse(
        format(matrixPackages, {
          output: "json",
          grouping: "consolidated",
          specifierMode,
          filter,
        }),
      );

      for (const output of outputs) {
        for (const grouping of groupings) {
          for (const textStyle of textStyles) {
            for (const recordSeparator of recordSeparators) {
              for (const specifierSeparator of specifierSeparators) {
                const options = {
                  output,
                  grouping,
                  textStyle,
                  recordSeparator,
                  specifierSeparator,
                  specifierMode,
                  filter,
                };
                const compatibility = getFormatCompatibility(
                  matrixPackages,
                  options,
                );
                if (!compatibility.supported) {
                  assert.throws(() => format(matrixPackages, options));
                  continue;
                }
                const rendered = format(matrixPackages, options);
                const reparsed = parse(rendered);
                assert.deepEqual(
                  reparsed.diagnostics,
                  [],
                  JSON.stringify(options),
                );
                assert.deepEqual(
                  reparsed.packages.map(({ name, specifiers }) => ({
                    name,
                    specifiers,
                  })),
                  output === "text" && recordSeparator === "newline"
                    ? [...expected].sort((a, b) => a.name.localeCompare(b.name))
                    : expected,
                  JSON.stringify(options),
                );
              }
            }
          }
        }
      }
    }
  }
});

test("returns documented empty output and rejects unknown presets", () => {
  assert.equal(format([], "json-consolidated"), "[]");
  assert.equal(format([], "csv-consolidated"), "");
  assert.throws(
    () => format([], "not-a-preset"),
    /Unknown format configuration/u,
  );
});
