import npa from "npm-package-arg";
import { valid } from "semver";

import {
  scanCsvRecord,
  scanLines,
  span,
  splitOutsideQuotes,
  trimSpan,
  type CsvField,
  type SourceLine,
} from "./scanner.js";
import type {
  DistTagAtom,
  ExactVersionAtom,
  NpmArgumentAtom,
  NpmPageAtom,
  PackageAtom,
  PackageOccurrence,
  ParseDiagnostic,
  ParsedAtom,
  ParsedPackage,
  ParsedSpecifier,
  ParseResult,
  SemverRangeAtom,
  SourceSpan,
  SpecifierListAtom,
  TarballAtom,
} from "./types.js";

type ParseState = {
  input: string;
  atoms: ParsedAtom[];
  diagnostics: ParseDiagnostic[];
};

const NPM_PAGE_RESERVED_PATHS = new Set([
  "about",
  "advisories",
  "features",
  "login",
  "org",
  "package",
  "policies",
  "pricing",
  "products",
  "search",
  "settings",
  "signup",
  "support",
]);

export function parse(input: string): ParseResult {
  const state: ParseState = { input, atoms: [], diagnostics: [] };
  if (parseFormattedJson(state)) {
    return {
      atoms: state.atoms,
      packages: aggregatePackages(state.atoms),
      diagnostics: state.diagnostics,
    };
  }
  const lines = scanLines(input);
  const formattedCsvHeader = findFormattedCsvHeader(state, lines);
  const headerIndex = findInventoryHeader(state, lines);

  if (formattedCsvHeader !== undefined) {
    parseFormattedCsv(state, lines, formattedCsvHeader);
  } else if (headerIndex !== undefined) {
    parseInventoryTable(state, lines, headerIndex);
  } else {
    for (const line of lines) parseLine(state, line);
  }

  return {
    atoms: state.atoms,
    packages: aggregatePackages(state.atoms),
    diagnostics: state.diagnostics,
  };
}

function parseFormattedJson(state: ParseState): boolean {
  const trimmed = state.input.trim();
  if (!trimmed.startsWith("[")) return false;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!Array.isArray(value)) return false;

  const records: Array<{ name: string; specifiers: string[] }> = [];
  for (const item of value) {
    if (!isJsonRecord(item) || typeof item.name !== "string") return false;
    if ("specifiers" in item) {
      if (
        !Array.isArray(item.specifiers) ||
        !item.specifiers.every((specifier) => typeof specifier === "string")
      ) {
        return false;
      }
      records.push({ name: item.name, specifiers: item.specifiers });
    } else if ("specifier" in item) {
      if (typeof item.specifier !== "string") return false;
      records.push({ name: item.name, specifiers: [item.specifier] });
    } else {
      records.push({ name: item.name, specifiers: [] });
    }
  }

  let cursor = 0;
  for (const record of records) {
    const encodedName = JSON.stringify(record.name);
    const nameIndex = state.input.indexOf(encodedName, cursor);
    const packageSpan =
      nameIndex >= 0
        ? span(
            state.input,
            nameIndex + 1,
            nameIndex + encodedName.length - 1,
          )
        : span(state.input, 0, state.input.length);
    cursor = nameIndex >= 0 ? nameIndex + encodedName.length : cursor;
    pushStructuredPackage(
      state,
      record.name,
      record.specifiers,
      span(state.input, 0, state.input.length),
      packageSpan,
    );
  }
  return true;
}

function isJsonRecord(
  value: unknown,
): value is Record<string, unknown> & { name?: unknown } {
  return typeof value === "object" && value !== null;
}

function findFormattedCsvHeader(
  state: ParseState,
  lines: SourceLine[],
): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.text.trim().length === 0) continue;
    const record = scanCsvRecord(state.input, line.start, line.end);
    if (record.malformedQuote) return undefined;
    const headers = record.fields.map((field) => field.value.trim().toLowerCase());
    return headers[0] === "package" &&
      ["specifier", "specifiers"].includes(headers[1] ?? "")
      ? index
      : undefined;
  }
  return undefined;
}

function parseFormattedCsv(
  state: ParseState,
  lines: SourceLine[],
  headerIndex: number,
): void {
  const headerLine = lines[headerIndex];
  if (!headerLine) return;
  const header = scanCsvRecord(state.input, headerLine.start, headerLine.end);
  const repeated =
    header.fields[1]?.value.trim().toLowerCase() === "specifier";
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.text.trim().length === 0) continue;
    const record = scanCsvRecord(state.input, line.start, line.end);
    if (record.malformedQuote) {
      addDiagnostic(
        state,
        "malformed-quoting",
        "Unterminated or malformed CSV quoting.",
        record.malformedQuote,
        "error",
      );
      continue;
    }
    const packageField = record.fields[0];
    const specifierField = record.fields[1];
    if (!packageField || !specifierField) {
      addDiagnostic(
        state,
        "unrecognized-input",
        "CSV row is missing a package or specifier field.",
        span(state.input, line.start, line.end),
      );
      continue;
    }
    const rowSpan = span(state.input, line.start, line.end);
    if (repeated) {
      pushStructuredPackage(
        state,
        packageField.value,
        specifierField.value.length > 0 ? [specifierField.value] : [],
        rowSpan,
        packageField.span,
      );
    } else {
      parseFieldRecord(
        state,
        packageField,
        specifierField.value.length > 0 ? [specifierField] : [],
        rowSpan,
      );
    }
  }
}

function pushStructuredPackage(
  state: ParseState,
  name: string,
  specifiers: string[],
  atomSpan: SourceSpan,
  packageSpan: SourceSpan,
): void {
  if (!isValidPackageName(name)) {
    addDiagnostic(
      state,
      "invalid-package",
      `Invalid npm package name "${name}".`,
      packageSpan,
      "error",
    );
    return;
  }
  if (specifiers.length === 0) {
    state.atoms.push({ type: "package", name, span: atomSpan, packageSpan });
    return;
  }
  const parsed: ParsedSpecifier[] = [];
  for (const value of specifiers) {
    const type = classifySpecifier(value);
    if (!type) {
      addDiagnostic(
        state,
        "invalid-specifier",
        `Invalid npm package specifier "${value}".`,
        atomSpan,
        "error",
      );
      continue;
    }
    parsed.push({ type, value, span: atomSpan });
  }
  state.atoms.push({
    type: "specifier-list",
    name,
    specifiers: parsed,
    span: atomSpan,
    packageSpan,
  });
}

function findInventoryHeader(
  state: ParseState,
  lines: SourceLine[],
): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.text.trim().length === 0) continue;
    const record = scanCsvRecord(state.input, line.start, line.end);
    if (record.malformedQuote) return undefined;
    const headers = record.fields.map((field) => field.value.trim().toLowerCase());
    return headers.includes("name") && headers.includes("version")
      ? index
      : undefined;
  }
  return undefined;
}

function parseInventoryTable(
  state: ParseState,
  lines: SourceLine[],
  headerIndex: number,
): void {
  const headerLine = lines[headerIndex];
  if (!headerLine) return;
  const headerRecord = scanCsvRecord(state.input, headerLine.start, headerLine.end);
  const columns = new Map<string, number>();

  for (const [index, field] of headerRecord.fields.entries()) {
    const name = field.value.trim().toLowerCase();
    if (columns.has(name)) {
      addDiagnostic(
        state,
        "unrecognized-input",
        `Duplicate CSV header "${field.value}".`,
        field.span,
      );
      continue;
    }
    columns.set(name, index);
  }

  const nameIndex = columns.get("name");
  const versionIndex = columns.get("version");
  if (nameIndex === undefined || versionIndex === undefined) return;

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.text.trim().length === 0) continue;
    const record = scanCsvRecord(state.input, line.start, line.end);
    if (record.malformedQuote) {
      addDiagnostic(
        state,
        "malformed-quoting",
        "Unterminated or malformed CSV quoting.",
        record.malformedQuote,
        "error",
      );
      continue;
    }

    const ecosystem = getField(record.fields, columns.get("ecosystem"));
    if (ecosystem && ecosystem.value.trim().toLowerCase() !== "npm") continue;

    const nameField = record.fields[nameIndex];
    const versionField = record.fields[versionIndex];
    if (!nameField || !versionField) {
      addDiagnostic(
        state,
        "unrecognized-input",
        "CSV row is missing a required Name or Version field.",
        span(state.input, line.start, line.end),
      );
      continue;
    }

    const namespaceField = getField(record.fields, columns.get("namespace"));
    const name = assembleInventoryName(namespaceField?.value ?? "", nameField.value);
    const packageSpan =
      namespaceField && namespaceField.value.trim().length > 0
        ? span(state.input, namespaceField.span.start, nameField.span.end)
        : nameField.span;

    if (!isValidPackageName(name)) {
      addDiagnostic(
        state,
        "invalid-package",
        `Invalid npm package name "${name}".`,
        packageSpan,
        "error",
      );
      continue;
    }

    const rowSpan = span(state.input, line.start, line.end);
    const version = versionField.value.trim();
    if (version.length === 0) {
      state.atoms.push({
        type: "package",
        name,
        span: rowSpan,
        packageSpan,
      });
      continue;
    }

    const atom = createSingleSpecifierAtom(
      state,
      name,
      packageSpan,
      versionField.span,
      rowSpan,
    );
    if (atom) state.atoms.push(atom);
  }
}

function getField(
  fields: CsvField[],
  index: number | undefined,
): CsvField | undefined {
  return index === undefined ? undefined : fields[index];
}

function assembleInventoryName(namespace: string, name: string): string {
  const cleanName = name.trim();
  const cleanNamespace = namespace.trim().replace(/^@/u, "");
  return cleanNamespace.length > 0 ? `@${cleanNamespace}/${cleanName}` : cleanName;
}

function parseLine(state: ParseState, line: SourceLine): void {
  let lineSpan = trimSpan(state.input, line.start, line.end);
  if (lineSpan.start === 0 && lineSpan.text.startsWith("\uFEFF")) {
    lineSpan = trimSpan(state.input, lineSpan.start + 1, lineSpan.end);
  }
  if (lineSpan.text.length === 0) return;

  if (isMarkdownSeparator(lineSpan.text) || isMarkdownHeader(lineSpan.text)) return;

  const markdownFields =
    lineSpan.text.startsWith("|") &&
    splitOutsideQuotes(state.input, lineSpan.start, lineSpan.end, "pipe");
  if (markdownFields && markdownFields.length >= 2) {
    const decodedFields = markdownFields.map((field) => ({
      value: field.text.replaceAll("\\|", "|").replaceAll("\\\\", "\\"),
      span: field,
    }));
    const packageField = decodedFields[0];
    if (packageField) {
      const specifierFields = decodedFields.slice(1);
      parseFieldRecord(
        state,
        packageField,
        specifierFields.every((field) => field.value.length === 0)
          ? []
          : specifierFields,
        lineSpan,
      );
      return;
    }
  }
  if (
    markdownFields &&
    markdownFields.length === 1 &&
    (lineSpan.text.match(/\|/gu)?.length ?? 0) >= 3
  ) {
    const packageField = markdownFields[0];
    if (packageField) {
      parseFieldRecord(state, packageField, [], lineSpan);
      return;
    }
  }

  lineSpan = stripListMarker(state.input, lineSpan);

  const commaSegments = splitOutsideQuotes(
    state.input,
    lineSpan.start,
    lineSpan.end,
    "comma",
  );
  if (
    commaSegments &&
    commaSegments.length > 1 &&
    isExplicitAtom(probeAtomic(state, commaSegments[0] ?? lineSpan, false))
  ) {
    parseInferredSegments(state, commaSegments);
    return;
  }

  const tokens = splitOutsideQuotes(
    state.input,
    lineSpan.start,
    lineSpan.end,
    "whitespace",
  );
  if (
    tokens &&
    tokens.length > 1 &&
    tokens.every((token) => probeAtomic(state, token, true) !== undefined) &&
    !isPackageFollowedByVersions(state, tokens)
  ) {
    parseTokenSequence(state, tokens);
    return;
  }

  const wholeAtom = parseAtomic(state, lineSpan, true);
  if (wholeAtom) {
    state.atoms.push(wholeAtom);
    return;
  }

  if (lineSpan.text.includes(",")) {
    const record = scanCsvRecord(state.input, lineSpan.start, lineSpan.end);
    if (record.malformedQuote) {
      addDiagnostic(
        state,
        "malformed-quoting",
        "Unterminated or malformed quoting.",
        record.malformedQuote,
        "error",
      );
      return;
    }
    if (record.fields.length >= 2 && isValidPackageName(record.fields[0]?.value ?? "")) {
      const packageField = record.fields[0];
      if (packageField) {
        parseFieldRecord(state, packageField, record.fields.slice(1), lineSpan);
        return;
      }
    }
  }

  if (tokens && tokens.length > 1) {
    if (parseTokenSequence(state, tokens) > 0) return;
  }

  if (hasUnclosedQuote(lineSpan.text)) {
    addDiagnostic(
      state,
      "malformed-quoting",
      "Unterminated quoted package specifier.",
      lineSpan,
      "error",
    );
    return;
  }

  addDiagnostic(
    state,
    "unrecognized-input",
    "Input does not match a supported npm package reference.",
    lineSpan,
  );
}

function parseInferredSegments(
  state: ParseState,
  segments: SourceSpan[],
): void {
  for (const segment of segments) {
    const wholeAtom = parseAtomic(state, segment, true);
    if (wholeAtom) {
      state.atoms.push(wholeAtom);
      continue;
    }

    const tokens = splitOutsideQuotes(
      state.input,
      segment.start,
      segment.end,
      "whitespace",
    );
    if (!tokens || tokens.length === 0) {
      addDiagnostic(
        state,
        "unrecognized-input",
        "Empty expression between separators.",
        segment,
      );
      continue;
    }

    parseTokenSequence(state, tokens);
  }
}

function parseTokenSequence(
  state: ParseState,
  tokens: SourceSpan[],
): number {
  let recognized = 0;
  for (const token of tokens) {
    const atom = parseAtomic(state, token, true);
    if (atom) {
      state.atoms.push(atom);
      recognized += 1;
      continue;
    }
    addInvalidTokenDiagnostic(state, token);
  }
  return recognized;
}

function addInvalidTokenDiagnostic(
  state: ParseState,
  token: SourceSpan,
): void {
  const attached = splitAttachedSpecifier(token.text);
  if (attached && isValidPackageName(attached.name)) {
    const specifierSpan = trimSpan(
      state.input,
      token.start + attached.specifierOffset,
      token.end,
    );
    addDiagnostic(
      state,
      "invalid-specifier",
      `Invalid npm package specifier "${specifierSpan.text}".`,
      specifierSpan,
      "error",
    );
    return;
  }
  addDiagnostic(
    state,
    "unrecognized-input",
    "Token does not match a supported npm package reference.",
    token,
  );
}

function isPackageFollowedByVersions(state: ParseState, tokens: SourceSpan[]): boolean {
  if (tokens.length < 2) return false;
  const first = tokens[0];
  if (!first) return false;
  const firstAtom = probeAtomic(state, first, true);
  if (!firstAtom || firstAtom.type !== "package") return false;
  return tokens.slice(1).every((token) => {
    const type = classifySpecifier(token.text);
    return type === "exact-version" || type === "semver-range";
  });
}

function isExplicitAtom(
  atom: ParsedAtom | undefined,
): atom is Exclude<ParsedAtom, PackageAtom> {
  return atom !== undefined && atom.type !== "package";
}

function probeAtomic(
  state: ParseState,
  source: SourceSpan,
  allowBare: boolean,
): ParsedAtom | undefined {
  const diagnosticCount = state.diagnostics.length;
  const atom = parseAtomic(state, source, allowBare);
  state.diagnostics.length = diagnosticCount;
  return atom;
}

function stripListMarker(input: string, source: SourceSpan): SourceSpan {
  const match = /^(?:[-*+]|\d+[.)])\s+/u.exec(source.text);
  return match ? trimSpan(input, source.start + match[0].length, source.end) : source;
}

function isMarkdownSeparator(text: string): boolean {
  const fields = text
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((field) => field.trim());
  return fields.length > 0 && fields.every((field) => /^:?-{3,}:?$/u.test(field));
}

function isMarkdownHeader(text: string): boolean {
  const fields = text
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((field) => field.trim().toLowerCase());
  return (
    fields.length >= 2 &&
    ["package", "name"].includes(fields[0] ?? "") &&
    ["version", "versions", "specifier", "specifiers"].includes(fields[1] ?? "")
  );
}

function parseFieldRecord(
  state: ParseState,
  packageField: CsvField | SourceSpan,
  specifierFields: Array<CsvField | SourceSpan>,
  recordSpan: SourceSpan,
): void {
  const name =
    "value" in packageField
      ? packageField.value.trim()
      : packageField.text.trim();
  const packageSpan = "value" in packageField ? packageField.span : packageField;
  if (!isValidPackageName(name)) {
    addDiagnostic(
      state,
      "invalid-package",
      `Invalid npm package name "${name}".`,
      packageSpan,
      "error",
    );
    return;
  }

  const specifiers: ParsedSpecifier[] = [];
  for (const field of specifierFields) {
    const fieldSpan = "value" in field ? field.span : field;
    const value = ("value" in field ? field.value : field.text).trim();
    const values =
      "value" in field && field.value !== field.span.text
        ? splitDecodedSpecifierValues(value, fieldSpan)
        : splitSpecifierValues(state.input, fieldSpan, value);
    for (const candidate of values) {
      const parsed = classifySpecifier(candidate.value);
      if (!parsed) {
        addDiagnostic(
          state,
          "invalid-specifier",
          candidate.value.length === 0
            ? "Empty package specifier."
            : `Invalid semver specifier "${candidate.value}".`,
          candidate.span,
          "error",
        );
        continue;
      }
      specifiers.push({ type: parsed, value: candidate.value, span: candidate.span });
    }
  }

  if (specifiers.length === 0 && specifierFields.length === 0) {
    state.atoms.push({ type: "package", name, span: recordSpan, packageSpan });
    return;
  }
  state.atoms.push({
    type: "specifier-list",
    name,
    specifiers,
    span: recordSpan,
    packageSpan,
  });
}

function splitDecodedSpecifierValues(
  value: string,
  source: SourceSpan,
): Array<{ value: string; span: SourceSpan }> {
  return value
    .split(",")
    .map((candidate) => ({ value: candidate.trim(), span: source }));
}

function parseAtomic(
  state: ParseState,
  source: SourceSpan,
  allowBare: boolean,
): ParsedAtom | undefined {
  const tarball = parseTarballUrl(state.input, source);
  if (tarball) return tarball;

  const npmPage = parseNpmPageUrl(state.input, source);
  if (npmPage) return npmPage;

  const quotedList = parseQuotedAttachedList(source.text);
  if (quotedList) {
    const { name, content, quoteOffset } = quotedList;
    if (!isValidPackageName(name)) return undefined;
    const packageSpan = span(state.input, source.start, source.start + name.length);
    const contentStart = source.start + quoteOffset + 1;
    const contentSpan = span(
      state.input,
      contentStart,
      contentStart + content.length,
    );
    return createSpecifierListAtom(state, name, packageSpan, contentSpan, source);
  }

  if (!/\s/u.test(source.text)) {
    const npmArgument = parseNpmArgument(state.input, source, allowBare);
    if (npmArgument) return npmArgument;
  }

  const attached = splitAttachedSpecifier(source.text);
  if (attached) {
    const { name, specifier, specifierOffset } = attached;
    if (!isValidPackageName(name)) return undefined;
    if (specifier.startsWith('"') || specifier.startsWith("'")) return undefined;
    const packageSpan = span(state.input, source.start, source.start + name.length);
    const specifierSpan = trimSpan(
      state.input,
      source.start + specifierOffset,
      source.end,
    );
    if (specifier.includes(",")) {
      return createSpecifierListAtom(
        state,
        name,
        packageSpan,
        specifierSpan,
        source,
      );
    }
    return createSingleSpecifierAtom(
      state,
      name,
      packageSpan,
      specifierSpan,
      source,
      false,
    );
  }

  const colon = /^(\S+?):\s+(.+)$/u.exec(source.text);
  if (colon) {
    const name = colon[1] ?? "";
    const specifier = colon[2] ?? "";
    if (!isValidPackageName(name)) return undefined;
    const specifierIndex = source.text.lastIndexOf(specifier);
    return createSingleSpecifierAtom(
      state,
      name,
      span(state.input, source.start, source.start + name.length),
      trimSpan(
        state.input,
        source.start + specifierIndex,
        source.start + specifierIndex + specifier.length,
      ),
      source,
      false,
    );
  }

  const spaced = /^(\S+)\s+(.+)$/u.exec(source.text);
  if (spaced) {
    const name = spaced[1] ?? "";
    const specifier = spaced[2] ?? "";
    if (!isValidPackageName(name)) return undefined;
    const specifierIndex = source.text.lastIndexOf(specifier);
    const specifierSpan = trimSpan(
      state.input,
      source.start + specifierIndex,
      source.start + specifierIndex + specifier.length,
    );
    const columns = splitOutsideQuotes(
      state.input,
      specifierSpan.start,
      specifierSpan.end,
      "whitespace",
    );
    const parsedColumns = columns?.map((column) => {
      const decoded = decodeQuotedColumn(state.input, column);
      return {
        type: classifySpecifier(decoded.value),
        value: decoded.value,
        span: decoded.span,
      };
    });
    if (
      parsedColumns?.length === 1 &&
      parsedColumns[0]?.type !== undefined
    ) {
      const column = parsedColumns[0];
      if (column.type === "npm-specifier") {
        return {
          type: "specifier-list",
          name,
          specifiers: [
            {
              type: column.type,
              value: column.value,
              span: column.span,
            },
          ],
          span: source,
          packageSpan: span(
            state.input,
            source.start,
            source.start + name.length,
          ),
        };
      }
      return createSingleSpecifierAtom(
        state,
        name,
        span(state.input, source.start, source.start + name.length),
        column.span,
        source,
        false,
      );
    }
    if (
      parsedColumns &&
      (parsedColumns.length > 1 ||
        parsedColumns.some(({ type }) => type === "npm-specifier")) &&
      parsedColumns.every(({ type }) => type !== undefined) &&
      (parsedColumns.some(
        ({ type, value }) =>
          type === "exact-version" || /^[~^]/u.test(value),
      ) ||
        parsedColumns.some(({ type }) => type === "npm-specifier"))
    ) {
      return {
        type: "specifier-list",
        name,
        specifiers: parsedColumns.map(({ type, value, span: column }) => ({
          type: type ?? "semver-range",
          value,
          span: column,
        })),
        span: source,
        packageSpan: span(
          state.input,
          source.start,
          source.start + name.length,
        ),
      };
    }

    function decodeQuotedColumn(
      input: string,
      source: SourceSpan,
    ): { value: string; span: SourceSpan } {
      const first = source.text[0];
      if (
        (first === '"' || first === "'") &&
        source.text.endsWith(first) &&
        source.text.length >= 2
      ) {
        const inner = span(input, source.start + 1, source.end - 1);
        return { value: inner.text, span: inner };
      }
      return { value: source.text, span: source };
    }
    return createSingleSpecifierAtom(
      state,
      name,
      span(state.input, source.start, source.start + name.length),
      specifierSpan,
      source,
      false,
    );
  }

  if (!allowBare || !isValidPackageName(source.text)) return undefined;
  return {
    type: "package",
    name: source.text,
    span: source,
    packageSpan: source,
  };
}

function splitAttachedSpecifier(
  text: string,
): { name: string; specifier: string; specifierOffset: number } | undefined {
  let separator = -1;
  if (text.startsWith("@")) {
    const slash = text.indexOf("/");
    if (slash < 0) return undefined;
    separator = text.indexOf("@", slash + 1);
  } else {
    separator = text.indexOf("@");
  }

  if (separator <= 0 || separator === text.length - 1) return undefined;
  return {
    name: text.slice(0, separator),
    specifier: text.slice(separator + 1),
    specifierOffset: separator + 1,
  };
}

function parseQuotedAttachedList(
  text: string,
): { name: string; content: string; quoteOffset: number } | undefined {
  const marker = /@(["'])/u.exec(text);
  if (!marker || marker.index <= 0) return undefined;
  const quote = marker[1];
  if (!quote || !text.endsWith(quote)) return undefined;
  const content = text.slice(marker.index + 2, -1);
  if (content.includes(quote)) return undefined;
  return {
    name: text.slice(0, marker.index),
    content,
    quoteOffset: marker.index + 1,
  };
}

function createSpecifierListAtom(
  state: ParseState,
  name: string,
  packageSpan: SourceSpan,
  contentSpan: SourceSpan,
  atomSpan: SourceSpan,
): SpecifierListAtom {
  const specifiers: ParsedSpecifier[] = [];
  for (const candidate of splitSpecifierValues(
    state.input,
    contentSpan,
    contentSpan.text,
  )) {
    const parsed = classifySpecifier(candidate.value);
    if (!parsed) {
      addDiagnostic(
        state,
        "invalid-specifier",
        candidate.value.length === 0
          ? "Empty package specifier."
          : `Invalid semver specifier "${candidate.value}".`,
        candidate.span,
        "error",
      );
      continue;
    }
    specifiers.push({ type: parsed, value: candidate.value, span: candidate.span });
  }
  return { type: "specifier-list", name, specifiers, span: atomSpan, packageSpan };
}

function splitSpecifierValues(
  input: string,
  source: SourceSpan,
  value: string,
): Array<{ value: string; span: SourceSpan }> {
  const values: Array<{ value: string; span: SourceSpan }> = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== ",") continue;
    const candidateSpan = trimSpan(input, source.start + start, source.start + index);
    values.push({ value: candidateSpan.text, span: candidateSpan });
    start = index + 1;
  }
  return values;
}

function createSingleSpecifierAtom(
  state: ParseState,
  name: string,
  packageSpan: SourceSpan,
  specifierSpan: SourceSpan,
  atomSpan: SourceSpan,
  reportInvalid = true,
): DistTagAtom | ExactVersionAtom | SemverRangeAtom | undefined {
  const type = classifySpecifier(specifierSpan.text);
  if (!type) {
    if (reportInvalid) {
      addDiagnostic(
        state,
        "invalid-specifier",
        `Invalid semver specifier "${specifierSpan.text}".`,
        specifierSpan,
        "error",
      );
    }
    return undefined;
  }
  if (type === "exact-version") {
    return {
      type,
      name,
      version: specifierSpan.text,
      span: atomSpan,
      packageSpan,
      specifierSpan,
    };
  }
  if (type === "dist-tag") {
    return {
      type,
      name,
      tag: specifierSpan.text,
      span: atomSpan,
      packageSpan,
      specifierSpan,
    };
  }
  if (type !== "semver-range") return undefined;
  return {
    type,
    name,
    range: specifierSpan.text,
    span: atomSpan,
    packageSpan,
    specifierSpan,
  };
}

function classifySpecifier(value: string): ParsedSpecifier["type"] | undefined {
  if (value.length === 0) return undefined;
  try {
    const result = npa.resolve("specifier-sink-placeholder", value, "/");
    if (result.type === "version") return "exact-version";
    if (result.type === "range") return "semver-range";
    if (result.type === "tag") return "dist-tag";
    if (
      ["alias", "directory", "file", "git", "remote"].includes(result.type)
    ) {
      return "npm-specifier";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseNpmArgument(
  input: string,
  source: SourceSpan,
  allowBare: boolean,
): ParsedAtom | undefined {
  let result: npa.Result;
  try {
    result = npa(source.text, "/");
  } catch {
    return undefined;
  }

  const name = result.name ?? null;
  const attached = name ? splitAttachedSpecifier(source.text) : undefined;
  const packageSpan =
    name === null
      ? null
      : span(input, source.start, source.start + name.length);
  const specifierSpan = attached
    ? trimSpan(input, source.start + attached.specifierOffset, source.end)
    : source;

  if (
    result.type === "range" &&
    result.rawSpec === "*" &&
    result.raw === result.name
  ) {
    if (!allowBare || !name || !packageSpan) return undefined;
    return { type: "package", name, span: source, packageSpan };
  }
  if (!name || !packageSpan) {
    return createUnboundNpmArgument(result, source, specifierSpan);
  }
  if (result.type === "version") {
    return {
      type: "exact-version",
      name,
      version: result.rawSpec,
      span: source,
      packageSpan,
      specifierSpan,
    };
  }
  if (result.type === "range") {
    return {
      type: "semver-range",
      name,
      range: result.rawSpec,
      span: source,
      packageSpan,
      specifierSpan,
    };
  }
  if (result.type === "tag") {
    return {
      type: "dist-tag",
      name,
      tag: result.rawSpec,
      span: source,
      packageSpan,
      specifierSpan,
    };
  }
  return {
    type: result.type === "alias" ? "npm-alias" : result.type,
    name,
    rawSpec: result.rawSpec,
    fetchSpec: result.fetchSpec,
    saveSpec: result.saveSpec,
    span: source,
    packageSpan,
    specifierSpan,
  };
}

function createUnboundNpmArgument(
  result: npa.Result,
  source: SourceSpan,
  specifierSpan: SourceSpan,
): NpmArgumentAtom | undefined {
  let type: NpmArgumentAtom["type"];
  switch (result.type) {
    case "alias":
      type = "npm-alias";
      break;
    case "directory":
    case "file":
    case "git":
    case "remote":
      type = result.type;
      break;
    case "range":
    case "tag":
    case "version":
      return undefined;
  }
  return {
    type,
    name: result.name,
    rawSpec: result.rawSpec,
    fetchSpec: result.fetchSpec,
    saveSpec: result.saveSpec,
    span: source,
    packageSpan: null,
    specifierSpan,
  };
}

function parseTarballUrl(input: string, source: SourceSpan): TarballAtom | undefined {
  const url = safeUrl(source.text);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "registry.npmjs.org"
  ) {
    return undefined;
  }
  const pathname = safeDecode(url.pathname);
  if (!pathname) return undefined;
  const separator = pathname.indexOf("/-/");
  if (separator < 1) return undefined;
  const name = pathname.slice(1, separator);
  const filename = pathname.slice(separator + 3);
  if (!isValidPackageName(name) || filename.includes("/")) return undefined;
  const basename = name.slice(name.lastIndexOf("/") + 1);
  const prefix = `${basename}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith(".tgz")) return undefined;
  const version = filename.slice(prefix.length, -4);
  if (valid(version) === null) return undefined;

  const packageMatch = findUrlPackageMatch(source.text, name);
  const versionIndex = source.text.lastIndexOf(version);
  return {
    type: "tarball",
    name,
    version,
    url: source.text,
    span: source,
    packageSpan:
      packageMatch
        ? span(
            input,
            source.start + packageMatch.index,
            source.start + packageMatch.index + packageMatch.length,
          )
        : source,
    specifierSpan:
      versionIndex >= 0
        ? span(input, source.start + versionIndex, source.start + versionIndex + version.length)
        : source,
  };
}

function parseNpmPageUrl(input: string, source: SourceSpan): NpmPageAtom | undefined {
  const url = safeUrl(source.text);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "www.npmjs.com"
  ) {
    return undefined;
  }
  const pathname = safeDecode(url.pathname)?.replace(/\/+$/u, "");
  if (!pathname || pathname === "/") return undefined;
  const rawPath = pathname.replace(/^\//u, "");
  const canonical = rawPath.startsWith("package/");
  const name = canonical ? rawPath.slice("package/".length) : rawPath;
  if (
    name.length === 0 ||
    (!name.startsWith("@") && name.includes("/")) ||
    (!canonical && NPM_PAGE_RESERVED_PATHS.has(name))
  ) {
    return undefined;
  }
  if (!isValidPackageName(name)) return undefined;
  const packageMatch = findUrlPackageMatch(source.text, name);
  return {
    type: "npm-page",
    name,
    url: source.text,
    span: source,
    packageSpan:
      packageMatch
        ? span(
            input,
            source.start + packageMatch.index,
            source.start + packageMatch.index + packageMatch.length,
          )
        : source,
  };
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function findUrlPackageMatch(
  url: string,
  name: string,
): { index: number; length: number } | undefined {
  const candidates = [
    name,
    encodeURIComponent(name),
    name.replace("/", "%2F"),
    name.replace("/", "%2f"),
  ];
  for (const candidate of candidates) {
    const index = url.toLowerCase().indexOf(candidate.toLowerCase());
    if (index >= 0) return { index, length: candidate.length };
  }
  return undefined;
}

function isValidPackageName(name: string): boolean {
  if (name.length === 0 || name !== name.trim()) {
    return false;
  }
  try {
    const result = npa(name, "/");
    return result.name === name && result.type === "range";
  } catch {
    return false;
  }
}

function hasUnclosedQuote(text: string): boolean {
  for (const quote of ['"', "'"] as const) {
    let open = false;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === quote && text[index - 1] !== "\\") open = !open;
    }
    if (open) return true;
  }
  return false;
}

function addDiagnostic(
  state: ParseState,
  code: ParseDiagnostic["code"],
  message: string,
  diagnosticSpan: SourceSpan,
  severity: ParseDiagnostic["severity"] = "warning",
): void {
  state.diagnostics.push({ code, message, severity, span: diagnosticSpan });
}

function aggregatePackages(atoms: ParsedAtom[]): ParsedPackage[] {
  const packages = new Map<string, ParsedPackage>();

  for (const atom of atoms) {
    if (!atom.name || !atom.packageSpan) continue;
    let parsedPackage = packages.get(atom.name);
    if (!parsedPackage) {
      parsedPackage = { name: atom.name, specifiers: [], occurrences: [] };
      packages.set(atom.name, parsedPackage);
    }

    const specifiers = atomSpecifiers(atom);
    for (const specifier of specifiers) {
      if (!parsedPackage.specifiers.includes(specifier.value)) {
        parsedPackage.specifiers.push(specifier.value);
      }
    }
    const occurrence: PackageOccurrence = {
      atomType: atom.type,
      span: atom.span,
      packageSpan: atom.packageSpan,
      specifierSpans: specifiers.map((specifier) => specifier.span),
    };
    parsedPackage.occurrences.push(occurrence);
  }

  return [...packages.values()];
}

function atomSpecifiers(atom: ParsedAtom): ParsedSpecifier[] {
  switch (atom.type) {
    case "exact-version":
    case "tarball":
      return [
        {
          type: "exact-version",
          value: atom.version,
          span: atom.specifierSpan,
        },
      ];
    case "semver-range":
      return [
        {
          type: "semver-range",
          value: atom.range,
          span: atom.specifierSpan,
        },
      ];
    case "dist-tag":
      return [
        {
          type: "dist-tag",
          value: atom.tag,
          span: atom.specifierSpan,
        },
      ];
    case "directory":
    case "file":
    case "git":
    case "npm-alias":
    case "remote":
      return [
        {
          type: "npm-specifier",
          value: atom.rawSpec,
          span: atom.specifierSpan,
        },
      ];
    case "specifier-list":
      return atom.specifiers;
    case "npm-page":
    case "package":
      return [];
  }
}
