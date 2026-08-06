import npa from "npm-package-arg";
import { clean, valid } from "semver";

import { parse } from "./parser.js";
import type {
  FormatCompatibility,
  ExcludedFormatEntry,
  FormatFilter,
  FormatOptions,
  FormatPreset,
  FormatSelection,
  ParsedPackage,
} from "./types.js";

type ResolvedFormatOptions = {
  output: FormatOptions["output"];
  grouping: NonNullable<FormatOptions["grouping"]>;
  textStyle: NonNullable<FormatOptions["textStyle"]>;
  recordSeparator: NonNullable<FormatOptions["recordSeparator"]>;
  specifierSeparator: NonNullable<FormatOptions["specifierSeparator"]>;
  specifierMode: NonNullable<FormatOptions["specifierMode"]>;
  filter: FormatFilter;
};

const DEFAULT_FILTER: FormatFilter = {
  exactVersions: true,
  semverRanges: true,
  distTags: true,
  packageOnly: true,
};

const PRESETS: Readonly<Record<FormatPreset, FormatOptions>> = {
  "json-consolidated": { output: "json", grouping: "consolidated" },
  "json-repeated": { output: "json", grouping: "repeated" },
  "csv-consolidated": { output: "csv", grouping: "consolidated" },
  "csv-repeated": { output: "csv", grouping: "repeated" },
  "markdown-consolidated": {
    output: "markdown",
    grouping: "consolidated",
  },
  "markdown-repeated": { output: "markdown", grouping: "repeated" },
  "newline-consolidated": {
    output: "text",
    grouping: "consolidated",
    textStyle: "attached",
    recordSeparator: "newline",
  },
  "newline-repeated": {
    output: "text",
    grouping: "repeated",
    textStyle: "attached",
    recordSeparator: "newline",
  },
  "space-consolidated": {
    output: "text",
    grouping: "consolidated",
    textStyle: "attached",
    recordSeparator: "space",
  },
  "space-repeated": {
    output: "text",
    grouping: "repeated",
    textStyle: "attached",
    recordSeparator: "space",
  },
  "tarball-newline": { output: "tarball" },
};

export function format(
  packages: readonly ParsedPackage[],
  options: FormatPreset | FormatOptions,
): string {
  const resolved = resolveOptions(options);
  const filtered = getFormatSelection(
    packages,
    resolved.filter,
    resolved.specifierMode,
  ).included;
  const compatibility = checkCompatibility(filtered, resolved);
  if (!compatibility.supported) {
    throw new TypeError(compatibility.reason);
  }
  return renderUnchecked(filtered, resolved);
}

function renderUnchecked(
  packages: readonly ParsedPackage[],
  resolved: ResolvedFormatOptions,
): string {
  if (packages.length === 0) {
    return resolved.output === "json" ? "[]" : "";
  }
  switch (resolved.output) {
    case "json":
      return JSON.stringify(
        resolved.grouping === "repeated"
          ? expand(packages)
          : packages.map(({ name, specifiers }) => ({ name, specifiers })),
        null,
        2,
      );
    case "csv":
      return formatCsv(packages, resolved.grouping === "repeated");
    case "markdown":
      return formatMarkdown(packages, resolved.grouping === "repeated");
    case "text":
      return formatText(packages, resolved);
    case "tarball":
      return formatTarballs(packages);
  }
}

export function getFormatCompatibility(
  packages: readonly ParsedPackage[],
  options: FormatPreset | FormatOptions,
): FormatCompatibility {
  const resolved = resolveOptions(options);
  return checkCompatibility(
    getFormatSelection(
      packages,
      resolved.filter,
      resolved.specifierMode,
    ).included,
    resolved,
  );
}

export function getFormatSelection(
  packages: readonly ParsedPackage[],
  filter: Partial<FormatFilter> = {},
  specifierMode: NonNullable<FormatOptions["specifierMode"]> = "include",
): FormatSelection {
  if (specifierMode === "names-only") {
    return {
      included: packages.map((parsedPackage) => ({
        ...parsedPackage,
        specifiers: [],
      })),
      excluded: [],
    };
  }
  const resolvedFilter = { ...DEFAULT_FILTER, ...filter };
  const included: ParsedPackage[] = [];
  const excluded: ExcludedFormatEntry[] = [];

  for (const parsedPackage of packages) {
    if (parsedPackage.specifiers.length === 0) {
      if (resolvedFilter.packageOnly) {
        included.push(parsedPackage);
      } else {
        excluded.push({
          name: parsedPackage.name,
          category: "package-only",
        });
      }
      continue;
    }

    const specifiers: string[] = [];
    for (const specifier of parsedPackage.specifiers) {
      const category = classifyForFilter(specifier);
      const enabled =
        category === "exact"
          ? resolvedFilter.exactVersions
          : category === "range"
            ? resolvedFilter.semverRanges
            : category === "tag"
              ? resolvedFilter.distTags
              : true;
      if (enabled) {
        specifiers.push(specifier);
      } else {
        excluded.push({
          name: parsedPackage.name,
          specifier,
          category:
            category === "exact"
              ? "exact-version"
              : category === "range"
                ? "semver-range"
                : "dist-tag",
        });
      }
    }
    if (specifiers.length > 0) {
      included.push({ ...parsedPackage, specifiers });
    }
  }

  return { included, excluded };
}

function resolveOptions(
  options: FormatPreset | FormatOptions,
): ResolvedFormatOptions {
  const provided =
    typeof options === "string" ? PRESETS[options] : options;
  if (!provided || !isOutput(provided.output)) {
    throw new TypeError(`Unknown format configuration: ${String(options)}`);
  }
  assertChoice("grouping", provided.grouping, ["consolidated", "repeated"]);
  assertChoice("textStyle", provided.textStyle, ["attached", "columns"]);
  assertChoice("recordSeparator", provided.recordSeparator, [
    "newline",
    "space",
  ]);
  assertChoice("specifierMode", provided.specifierMode, [
    "include",
    "names-only",
  ]);
  assertChoice("specifierSeparator", provided.specifierSeparator, [
    "comma",
    "space",
  ]);
  return {
    output: provided.output,
    grouping: provided.grouping ?? "consolidated",
    textStyle: provided.textStyle ?? "attached",
    recordSeparator: provided.recordSeparator ?? "newline",
    specifierSeparator: provided.specifierSeparator ?? "space",
    specifierMode: provided.specifierMode ?? "include",
    filter: {
      ...DEFAULT_FILTER,
      ...provided.filter,
    },
  };
}

function assertChoice(
  name: string,
  value: string | undefined,
  choices: readonly string[],
): void {
  if (value !== undefined && !choices.includes(value)) {
    throw new TypeError(`Unknown ${name} option: ${value}`);
  }
}

function isOutput(value: unknown): value is FormatOptions["output"] {
  return ["json", "csv", "markdown", "text", "tarball"].includes(
    String(value),
  );
}

function classifyForFilter(
  specifier: string,
): "exact" | "other" | "range" | "tag" {
  try {
    const result = npa.resolve("specifier-sink-placeholder", specifier, "/");
    if (result.type === "version") return "exact";
    if (result.type === "range") return "range";
    if (result.type === "tag") return "tag";
    return "other";
  } catch {
    return "other";
  }
}

function checkCompatibility(
  packages: readonly ParsedPackage[],
  options: ResolvedFormatOptions,
): FormatCompatibility {
  if (options.output === "tarball") {
    const unsupported = packages.some(
      ({ specifiers }) =>
        specifiers.length === 0 ||
        specifiers.some(
          (specifier) => normalizeExactVersion(specifier) === undefined,
        ),
    );
    return unsupported
      ? {
          supported: false,
          reason:
            "Tarball output requires every retained package to have only exact versions.",
        }
      : checkRoundTrip(packages, options);
  }

  if (
    (options.output === "csv" || options.output === "markdown") &&
    options.grouping === "consolidated" &&
    packages.some(({ specifiers }) =>
      specifiers.some((specifier) => specifier.includes(",")),
    )
  ) {
    return {
      supported: false,
      reason:
        "Consolidated tabular output cannot round-trip specifiers containing commas.",
    };
  }

  if (
    options.output === "markdown" &&
    packages.some(({ specifiers }) =>
      specifiers.some((specifier) => /[\r\n]/u.test(specifier)),
    )
  ) {
    return {
      supported: false,
      reason: "Markdown output cannot round-trip multiline specifiers.",
    };
  }

  if (options.output !== "text") return checkRoundTrip(packages, options);
  if (options.textStyle === "columns") {
    if (options.recordSeparator !== "newline") {
      return {
        supported: false,
        reason:
          "Package-first columns require newline-separated records to preserve package boundaries.",
      };
    }
    if (options.specifierSeparator !== "space") {
      return {
        supported: false,
        reason:
          "Package-first columns require space-separated specifiers for round-trip parsing.",
      };
    }
    if (
      packages.some(({ specifiers }) =>
        specifiers.some((specifier) => /["'\r\n]/u.test(specifier)),
      )
    ) {
      return {
        supported: false,
        reason:
          "Package-first columns cannot round-trip specifiers containing quotes or newlines.",
      };
    }
    return checkRoundTrip(packages, options);
  }

  if (
    packages.some(({ specifiers }) =>
      specifiers.some((specifier) => /[,"'\r\n]/u.test(specifier)),
    )
  ) {
    return {
      supported: false,
      reason:
        "Attached text cannot round-trip specifiers containing commas, quotes, or newlines.",
    };
  }
  return checkRoundTrip(packages, options);
}

function checkRoundTrip(
  packages: readonly ParsedPackage[],
  options: ResolvedFormatOptions,
): FormatCompatibility {
  const rendered = renderUnchecked(packages, options);
  const reparsed = parse(rendered);
  if (reparsed.diagnostics.length > 0) {
    return {
      supported: false,
      reason: "This combination produces output that reparses with diagnostics.",
    };
  }
  const expected = packages.map(({ name, specifiers }) => ({
    name,
    specifiers:
      options.output === "tarball"
        ? specifiers.map((specifier) => normalizeExactVersion(specifier) ?? specifier)
        : specifiers,
  }));
  const actual = reparsed.packages.map(({ name, specifiers }) => ({
    name,
    specifiers,
  }));
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? { supported: true }
    : {
        supported: false,
        reason:
          "This combination cannot preserve package and specifier boundaries when reparsed.",
      };
}

function expand(
  packages: readonly ParsedPackage[],
): Array<{ name: string; specifier?: string }> {
  return packages.flatMap(({ name, specifiers }) =>
    specifiers.length === 0
      ? [{ name }]
      : specifiers.map((specifier) => ({ name, specifier })),
  );
}

function formatCsv(
  packages: readonly ParsedPackage[],
  repeated: boolean,
): string {
  const rows = repeated
    ? expand(packages).map(({ name, specifier }) => [name, specifier ?? ""])
    : packages.map(({ name, specifiers }) => [name, specifiers.join(",")]);
  const header = repeated
    ? ["package", "specifier"]
    : ["package", "specifiers"];
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function formatMarkdown(
  packages: readonly ParsedPackage[],
  repeated: boolean,
): string {
  const headers = repeated
    ? ["package", "specifier"]
    : ["package", "specifiers"];
  const rows = repeated
    ? expand(packages).map(({ name, specifier }) => [name, specifier ?? ""])
    : packages.map(({ name, specifiers }) => [name, specifiers.join(", ")]);
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function formatText(
  packages: readonly ParsedPackage[],
  options: ResolvedFormatOptions,
): string {
  const records =
    options.grouping === "repeated"
      ? expand(packages).map(({ name, specifier }) =>
          formatTextRecord(name, specifier ? [specifier] : [], options),
        )
      : packages.map(({ name, specifiers }) =>
          formatTextRecord(name, specifiers, options),
        );
  return records.join(options.recordSeparator === "space" ? " " : "\n");
}

function formatTextRecord(
  name: string,
  specifiers: readonly string[],
  options: ResolvedFormatOptions,
): string {
  if (specifiers.length === 0) return name;
  if (options.textStyle === "columns") {
    const separator = options.specifierSeparator === "comma" ? ", " : " ";
    return `${name} ${specifiers.map(quoteIfNeeded).join(separator)}`;
  }
  if (specifiers.length === 1) {
    return `${name}@${quoteIfNeeded(specifiers[0] ?? "")}`;
  }
  return `${name}@"${specifiers.join(",")}"`;
}

function quoteIfNeeded(value: string): string {
  return /[\s,]/u.test(value) ? `"${value}"` : value;
}

function formatTarballs(packages: readonly ParsedPackage[]): string {
  const urls: string[] = [];
  for (const { name, specifiers } of packages) {
    const basename = name.slice(name.lastIndexOf("/") + 1);
    for (const specifier of specifiers) {
      const version = normalizeExactVersion(specifier);
      if (version === undefined) continue;
      urls.push(
        `https://registry.npmjs.org/${name}/-/${basename}-${encodeURIComponent(version)}.tgz`,
      );
    }
  }
  return urls.join("\n");
}

function normalizeExactVersion(specifier: string): string | undefined {
  try {
    const result = npa.resolve("specifier-sink-placeholder", specifier, "/");
    return result.type === "version" ? (clean(result.fetchSpec) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}
