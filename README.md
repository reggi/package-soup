# package-soup

<p align="center">
  <img src="https://raw.githubusercontent.com/reggi/package-soup/main/assets/package-soup.svg" alt="Pixel art bowl of package soup" width="160" height="160">
</p>

Synchronously extract npm package names and package specifiers from mixed text,
then render the normalized result in standardized formats.

The library is deterministic and fully offline. It never performs registry
resolution or contacts npm or any URL found in the input.

## Install

```sh
npm install package-soup
```

## Parse

```ts
import { parse } from "package-soup";

const result = parse(`
react@18.3.1
lodash
react@10.2.3
package@"10.0.0,9.0.2"
https://www.npmjs.com/package/zod
`);

console.log(result.packages);
```

```json
[
  {
    "name": "react",
    "specifiers": ["18.3.1", "10.2.3"]
  },
  {
    "name": "lodash",
    "specifiers": []
  },
  {
    "name": "package",
    "specifiers": ["10.0.0", "9.0.2"]
  },
  {
    "name": "zod",
    "specifiers": []
  }
]
```

`parse()` returns:

- `atoms`: recognized source expressions in source order.
- `packages`: packages deduplicated by name, with specifiers deduplicated in
  first-seen order.
- `diagnostics`: invalid or ambiguous source spans for inline reporting.

All offsets are zero-based, half-open UTF-16 indices into the original string.

## Atomic types

| Input | Atom type |
| --- | --- |
| `lodash` | `package` |
| `lodash@1.0.0` | `exact-version` |
| `lodash@^1.0.0` | `semver-range` |
| `lodash@latest` | `dist-tag` |
| `lodash@"1.0.0,^2.0.0"` | `specifier-list` |
| `alias@npm:lodash@^4` | `npm-alias` |
| `git+https://github.com/npm/cli.git` | `git` |
| `https://example.com/package.tgz` | `remote` |
| `file:../package` | `directory` |
| `https://registry.npmjs.org/lodash/-/lodash-1.0.0.tgz` | `tarball` |
| `https://www.npmjs.com/package/lodash` | `npm-page` |
| `https://www.npmjs.com/lodash` | `npm-page` |

Mixed atom types and supported source formats can appear in one input.
Top-level commas and whitespace can separate heterogeneous expressions on the
same line. References are inferred independently:

```text
react@18.3.1, lodash
react@^19.0.0, @types/node: >=20 <23
package@"10.0.0,9.0.2", https://www.npmjs.com/package/zod bad package@wat
```

The standard npm specifier layer is powered by `npm-package-arg`, then extended
with lists, tables, npm page URLs, aggregation, source spans, and formatting.
Both `package@latest` and `package@wat` are syntactically valid dist-tags;
offline parsing cannot determine whether either tag exists in the registry.

## Supported source formats

### Newline and space-separated expressions

```text
react@18.3.1
lodash
package@"10.0.0,9.0.2" bpackage@"10.0.0,9.0.2"
```

### Positional CSV-like rows

```csv
react,^18.2.0,18.3.1
lodash,^4.17.0,4.17.21
```

### Header-based npm inventory CSV

```csv
Ecosystem,Namespace,Name,Version,Artifact,Published,Detected
npm,,reggi,6.0.0,,2026-08-04T09:35:00.763Z,2026-08-04T09:41:25.543Z
npm,@reggi,docs-viewer,1.6.2,,2026-08-04T09:38:13.626Z,2026-08-04T09:44:25.577Z
```

Header names are matched case-insensitively and may be reordered. Non-npm rows
are skipped.

### Markdown tables and lists

```markdown
| package | versions |
| --- | --- |
| zod | ^3.23.0, 3.24.1 |

- @types/node: >=20 <23
- typescript: ~5.6.0
```

### npm URLs

```text
https://registry.npmjs.org/react/-/react-18.3.1.tgz
https://www.npmjs.com/package/lodash
https://www.npmjs.com/zod
```

Scoped names and percent-encoded scoped URL paths are supported.

## Diagnostics and partial recovery

Valid data is retained when boundaries are unambiguous:

```ts
parse('lodash@"1.0.0,"');
```

This produces a `specifier-list` containing `1.0.0` and an
`invalid-specifier` diagnostic for the empty trailing item.

Whitespace-separated tokens are recovered independently:

```text
bad package@wat
```

This returns package-only `bad` and a `dist-tag` atom for `package@wat`, matching
`npm-package-arg` semantics.

## Format

```ts
import { format, parse } from "package-soup";

const { packages } = parse("react@18.3.1\nreact@^19.0.0\nlodash");

format(packages, {
  output: "text",
  grouping: "consolidated",
  textStyle: "columns",
  recordSeparator: "newline",
  specifierSeparator: "space",
});
// react 18.3.1 ^19.0.0
// lodash

format(packages, {
  output: "text",
  grouping: "consolidated",
  textStyle: "attached",
});
// react@"18.3.1,^19.0.0"
// lodash
```

Formatter choices can be composed when the resulting representation remains
unambiguous:

| Option | Values |
| --- | --- |
| `output` | `json`, `csv`, `markdown`, `text`, `tarball` |
| `grouping` | `consolidated`, `repeated` |
| `textStyle` | `columns`, `attached` |
| `recordSeparator` | `newline`, `space` |
| `specifierSeparator` | `space`, `comma` |
| `specifierMode` | `include`, `names-only` |
| `filter.exactVersions` | Include exact versions; defaults to `true` |
| `filter.semverRanges` | Include semver ranges; defaults to `true` |
| `filter.distTags` | Include dist-tags; defaults to `true` |
| `filter.packageOnly` | Include packages without specifiers; defaults to `true` |

`specifierMode: "names-only"` emits every deduplicated package exactly once
without any specifiers. It intentionally ignores the category filters.

Use `getFormatSelection(packages, filter, specifierMode)` to inspect the exact
partition before formatting. It returns `included` packages and `excluded`
entries labeled as exact versions, semver ranges, dist-tags, or package-only
records.

Preset strings such as `json-consolidated`, `newline-repeated`, and
`space-consolidated` are also supported.

Supported formatter configurations parse back to the same normalized
package/specifier data, except tarball output canonicalizes exact-version
spellings such as `v1.2.3` and `=1.2.3` to `1.2.3`. Use
`getFormatCompatibility(packages, options)` to test a configuration. `format()`
throws for combinations that cannot round-trip; the browser app automatically
switches unsupported selections to JSON.

Tarball output is available only when the retained data contains exact versions
for every package. Filters can remove ranges, dist-tags, and package-only
entries first. Exact versions are canonicalized in generated URLs. No registry
lookup or range resolution is performed.

## Semver and package-name behavior

Semver validation includes exact versions, partials, wildcards, comparator
sets, caret and tilde ranges, hyphen ranges, OR ranges, prereleases, and build
metadata.

Package names are validated syntactically. The parser does not verify that a
package exists or that a URL is reachable.

Dist-tags, npm aliases, Git references, remote tarballs, local files, and local
directories follow `npm-package-arg` semantics.

## Static demo

The browser demo in `site/` provides a live two-panel parser and formatter.
It uses the same synchronous package API and performs no network requests.
Entries removed by the Include filters appear in an “Excluded by filters”
section below the formatted output.

```sh
npm run dev:site
npm run build:site
```

The production site is emitted as one self-contained
`site-dist/index.html`. Open that file directly in a browser—no local server
is required. Its CSS and JavaScript are inlined, so it also works over a
`file://` URL.

The source text, output choices, grouping, syntax, separators, names-only mode,
and all Include filters are restored from versioned `localStorage`. Browsers
that disable storage still run the app normally without persistence.

GitHub Actions deploys `site-dist/` to GitHub Pages on pushes to `main`. Site
sources, workflow files, and generated site assets are excluded from the npm
package by the `package.json` `files` allowlist.
