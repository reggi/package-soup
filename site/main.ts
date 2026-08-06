import {
  format,
  getFormatCompatibility,
  getFormatSelection,
  parse,
} from "../src/index.ts";
import type {
  ExcludedFormatEntry,
  FormatOptions,
  ParseDiagnostic,
  ParseResult,
} from "../src/index.ts";

import "./styles.css";

const STORAGE_KEY = "package-soup:page-state:v1";

type StoredPageState = {
  version: 1;
  source: string;
  output: FormatOptions["output"];
  grouping: NonNullable<FormatOptions["grouping"]>;
  specifierMode: NonNullable<FormatOptions["specifierMode"]>;
  textStyle: NonNullable<FormatOptions["textStyle"]>;
  recordSeparator: NonNullable<FormatOptions["recordSeparator"]>;
  specifierSeparator: NonNullable<FormatOptions["specifierSeparator"]>;
  filter: {
    exactVersions: boolean;
    semverRanges: boolean;
    distTags: boolean;
    packageOnly: boolean;
  };
};

const example = `react@18.3.1, lodash
react@^19.0.0, @types/node: >=20 <23
package@"10.0.0,9.0.2", https://www.npmjs.com/package/zod bad package@wat`;

const source = element<HTMLTextAreaElement>("source");
const output = element<HTMLElement>("output");
const emptyOutput = element<HTMLElement>("empty-output");
const outputFamily = element<HTMLSelectElement>("output-family");
const grouping = element<HTMLSelectElement>("grouping");
const specifierMode = element<HTMLSelectElement>("specifier-mode");
const textStyle = element<HTMLSelectElement>("text-style");
const recordSeparator = element<HTMLSelectElement>("record-separator");
const specifierSeparator = element<HTMLSelectElement>("specifier-separator");
const groupingControl = element<HTMLElement>("grouping-control");
const textStyleControl = element<HTMLElement>("text-style-control");
const recordSeparatorControl = element<HTMLElement>(
  "record-separator-control",
);
const specifierSeparatorControl = element<HTMLElement>(
  "specifier-separator-control",
);
const filterExact = element<HTMLInputElement>("filter-exact");
const filterRanges = element<HTMLInputElement>("filter-ranges");
const filterTags = element<HTMLInputElement>("filter-tags");
const filterPackages = element<HTMLInputElement>("filter-packages");
const filterControl = element<HTMLElement>("filter-control");
const formatNote = element<HTMLElement>("format-note");
const excludedOutput = element<HTMLElement>("excluded-output");
const excludedCount = element<HTMLElement>("excluded-count");
const excludedList = element<HTMLElement>("excluded-list");
const storageNote = element<HTMLElement>("storage-note");
const diagnostics = element<HTMLElement>("diagnostics");
const packageCount = element<HTMLElement>("package-count");
const specifierCount = element<HTMLElement>("specifier-count");
const diagnosticCount = element<HTMLElement>("diagnostic-count");
const copyButton = element<HTMLButtonElement>("copy-button");
const copyLabel = element<HTMLElement>("copy-label");
const exampleButton = element<HTMLButtonElement>("example-button");
const clearButton = element<HTMLButtonElement>("clear-button");

if (!restorePageState()) source.value = example;

source.addEventListener("input", render);
for (const control of [
  outputFamily,
  grouping,
  specifierMode,
  textStyle,
  recordSeparator,
  specifierSeparator,
  filterExact,
  filterRanges,
  filterTags,
  filterPackages,
]) {
  control.addEventListener("change", render);
}
exampleButton.addEventListener("click", () => {
  source.value = example;
  source.focus();
  render();
});
clearButton.addEventListener("click", () => {
  source.value = "";
  source.focus();
  render();
});
copyButton.addEventListener("click", copyOutput);

render();

function render(): void {
  const result = parse(source.value);
  normalizeControls(result.packages);
  const options = getFormatOptions();
  const formatted = format(result.packages, options);
  const selection = getFormatSelection(
    result.packages,
    options.filter,
    options.specifierMode,
  );

  updateControlVisibility(options);
  output.textContent = formatted;
  output.hidden = formatted.length === 0;
  emptyOutput.hidden = formatted.length > 0;
  packageCount.textContent = String(result.packages.length);
  specifierCount.textContent = String(
    result.packages.reduce(
      (total, parsedPackage) => total + parsedPackage.specifiers.length,
      0,
    ),
  );
  diagnosticCount.textContent = String(result.diagnostics.length);
  renderDiagnostics(result);
  renderExcluded(selection.excluded);
  savePageState();
}

function getFormatOptions(): FormatOptions {
  return {
    output: outputFamily.value as FormatOptions["output"],
    grouping: grouping.value as NonNullable<FormatOptions["grouping"]>,
    specifierMode:
      specifierMode.value as NonNullable<FormatOptions["specifierMode"]>,
    textStyle: textStyle.value as NonNullable<FormatOptions["textStyle"]>,
    recordSeparator:
      recordSeparator.value as NonNullable<FormatOptions["recordSeparator"]>,
    specifierSeparator:
      specifierSeparator.value as NonNullable<
        FormatOptions["specifierSeparator"]
      >,
    filter: {
      exactVersions: filterExact.checked,
      semverRanges: filterRanges.checked,
      distTags: filterTags.checked,
      packageOnly: filterPackages.checked,
    },
  };
}

function updateControlVisibility(options: FormatOptions): void {
  const isText = options.output === "text";
  groupingControl.hidden = options.output === "tarball";
  textStyleControl.hidden = !isText;
  recordSeparatorControl.hidden = !isText;
  specifierSeparatorControl.hidden =
    !isText ||
    options.textStyle !== "columns" ||
    options.grouping === "repeated";
  filterControl.hidden = options.specifierMode === "names-only";
}

function normalizeControls(packages: ParseResult["packages"]): void {
  const base = getFormatOptions();
  const compatibility = getFormatCompatibility(packages, base);

  if (!compatibility.supported) {
    applyFormatOptions({
      ...base,
      output: "json",
      grouping: "consolidated",
    });
  }

  formatNote.hidden = compatibility.supported;
  formatNote.textContent = compatibility.supported
    ? ""
    : `${compatibility.reason ?? "Unsupported combination"} Switched to JSON.`;
}

function applyFormatOptions(options: FormatOptions): void {
  outputFamily.value = options.output;
  if (options.grouping) grouping.value = options.grouping;
  if (options.specifierMode) specifierMode.value = options.specifierMode;
  if (options.textStyle) textStyle.value = options.textStyle;
  if (options.recordSeparator) recordSeparator.value = options.recordSeparator;
  if (options.specifierSeparator) {
    specifierSeparator.value = options.specifierSeparator;
  }
}

function renderDiagnostics(result: ParseResult): void {
  diagnostics.replaceChildren();
  if (result.diagnostics.length === 0) {
    const message = document.createElement("p");
    message.className = "diagnostic-ok";
    message.textContent =
      result.atoms.length === 0 ? "Waiting for input." : "All input recognized.";
    diagnostics.append(message);
    return;
  }

  const heading = document.createElement("p");
  heading.className = "diagnostic-heading";
  heading.textContent = "Review unrecognized input";
  const list = document.createElement("ul");

  for (const diagnostic of result.diagnostics) {
    list.append(createDiagnosticItem(diagnostic));
  }
  diagnostics.append(heading, list);
}

function createDiagnosticItem(diagnostic: ParseDiagnostic): HTMLLIElement {
  const item = document.createElement("li");
  const location = getLocation(source.value, diagnostic.span.start);
  const code = document.createElement("code");
  code.textContent = diagnostic.span.text || "(empty value)";
  const message = document.createElement("span");
  message.textContent = `${diagnostic.message} Line ${location.line}, column ${location.column}.`;
  item.append(code, message);
  return item;
}

function renderExcluded(entries: ExcludedFormatEntry[]): void {
  excludedOutput.hidden = entries.length === 0;
  excludedCount.textContent = String(entries.length);
  excludedList.replaceChildren();

  for (const entry of entries) {
    const item = document.createElement("li");
    const reference = document.createElement("code");
    reference.textContent =
      entry.specifier === undefined
        ? entry.name
        : `${entry.name}@${entry.specifier}`;
    const category = document.createElement("span");
    category.textContent = exclusionLabel(entry.category);
    item.append(reference, category);
    excludedList.append(item);
  }
}

function exclusionLabel(category: ExcludedFormatEntry["category"]): string {
  switch (category) {
    case "exact-version":
      return "Exact version";
    case "semver-range":
      return "Semver range";
    case "dist-tag":
      return "Dist-tag";
    case "package-only":
      return "Package only";
  }
}

function restorePageState(): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    handleStorageError(error);
    return false;
  }
  if (!raw) return false;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("Ignoring invalid saved page state.", error);
    return false;
  }
  if (!isStoredPageState(value)) return false;

  source.value = value.source;
  setSelectValue(outputFamily, value.output);
  setSelectValue(grouping, value.grouping);
  setSelectValue(specifierMode, value.specifierMode);
  setSelectValue(textStyle, value.textStyle);
  setSelectValue(recordSeparator, value.recordSeparator);
  setSelectValue(specifierSeparator, value.specifierSeparator);
  filterExact.checked = value.filter.exactVersions;
  filterRanges.checked = value.filter.semverRanges;
  filterTags.checked = value.filter.distTags;
  filterPackages.checked = value.filter.packageOnly;
  return true;
}

function savePageState(): void {
  const options = getFormatOptions();
  const state: StoredPageState = {
    version: 1,
    source: source.value,
    output: options.output,
    grouping: options.grouping ?? "consolidated",
    specifierMode: options.specifierMode ?? "include",
    textStyle: options.textStyle ?? "attached",
    recordSeparator: options.recordSeparator ?? "newline",
    specifierSeparator: options.specifierSeparator ?? "space",
    filter: {
      exactVersions: options.filter?.exactVersions ?? true,
      semverRanges: options.filter?.semverRanges ?? true,
      distTags: options.filter?.distTags ?? true,
      packageOnly: options.filter?.packageOnly ?? true,
    },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageNote.hidden = true;
  } catch (error) {
    handleStorageError(error);
  }
}

function isStoredPageState(value: unknown): value is StoredPageState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<StoredPageState>;
  return (
    state.version === 1 &&
    typeof state.source === "string" &&
    typeof state.output === "string" &&
    typeof state.grouping === "string" &&
    typeof state.specifierMode === "string" &&
    typeof state.textStyle === "string" &&
    typeof state.recordSeparator === "string" &&
    typeof state.specifierSeparator === "string" &&
    typeof state.filter === "object" &&
    state.filter !== null &&
    typeof state.filter.exactVersions === "boolean" &&
    typeof state.filter.semverRanges === "boolean" &&
    typeof state.filter.distTags === "boolean" &&
    typeof state.filter.packageOnly === "boolean"
  );
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  if ([...select.options].some((candidate) => candidate.value === value)) {
    select.value = value;
  }
}

function handleStorageError(error: unknown): void {
  if (error instanceof DOMException) {
    storageNote.hidden = false;
    console.warn("Page state storage is unavailable.", error);
    return;
  }
  throw error;
}

function getLocation(
  input: string,
  offset: number,
): { line: number; column: number } {
  const preceding = input.slice(0, offset);
  const lines = preceding.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

async function copyOutput(): Promise<void> {
  if (!output.textContent) return;
  await navigator.clipboard.writeText(output.textContent);
  copyLabel.textContent = "Copied";
  copyButton.classList.add("copied");
  window.setTimeout(() => {
    copyLabel.textContent = "Copy";
    copyButton.classList.remove("copied");
  }, 1_400);
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}
