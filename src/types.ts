export type SourceSpan = {
  start: number;
  end: number;
  text: string;
};

export type ParsedSpecifier = {
  type: "dist-tag" | "exact-version" | "npm-specifier" | "semver-range";
  value: string;
  span: SourceSpan;
};

type BaseAtom = {
  name: string;
  span: SourceSpan;
  packageSpan: SourceSpan;
};

export type PackageAtom = BaseAtom & {
  type: "package";
};

export type ExactVersionAtom = BaseAtom & {
  type: "exact-version";
  version: string;
  specifierSpan: SourceSpan;
};

export type SemverRangeAtom = BaseAtom & {
  type: "semver-range";
  range: string;
  specifierSpan: SourceSpan;
};

export type DistTagAtom = BaseAtom & {
  type: "dist-tag";
  tag: string;
  specifierSpan: SourceSpan;
};

export type SpecifierListAtom = BaseAtom & {
  type: "specifier-list";
  specifiers: ParsedSpecifier[];
};

export type TarballAtom = BaseAtom & {
  type: "tarball";
  version: string;
  url: string;
  specifierSpan: SourceSpan;
};

export type NpmPageAtom = BaseAtom & {
  type: "npm-page";
  url: string;
};

export type NpmArgumentAtom = {
  type: "directory" | "file" | "git" | "npm-alias" | "remote";
  name: string | null;
  rawSpec: string;
  fetchSpec: string | null;
  saveSpec: string | null;
  span: SourceSpan;
  packageSpan: SourceSpan | null;
  specifierSpan: SourceSpan;
};

export type ParsedAtom =
  | PackageAtom
  | ExactVersionAtom
  | SemverRangeAtom
  | DistTagAtom
  | SpecifierListAtom
  | TarballAtom
  | NpmPageAtom
  | NpmArgumentAtom;

export type PackageOccurrence = {
  atomType: ParsedAtom["type"];
  span: SourceSpan;
  packageSpan: SourceSpan;
  specifierSpans: SourceSpan[];
};

export type ParsedPackage = {
  name: string;
  specifiers: string[];
  occurrences: PackageOccurrence[];
};

export type ParseDiagnosticCode =
  | "unrecognized-input"
  | "invalid-package"
  | "invalid-specifier"
  | "malformed-quoting";

export type ParseDiagnostic = {
  code: ParseDiagnosticCode;
  message: string;
  severity: "warning" | "error";
  span: SourceSpan;
};

export type ParseResult = {
  atoms: ParsedAtom[];
  packages: ParsedPackage[];
  diagnostics: ParseDiagnostic[];
};

export type FormatPreset =
  | "json-consolidated"
  | "json-repeated"
  | "csv-consolidated"
  | "csv-repeated"
  | "markdown-consolidated"
  | "markdown-repeated"
  | "newline-consolidated"
  | "newline-repeated"
  | "space-consolidated"
  | "space-repeated"
  | "tarball-newline";

export type FormatOptions = {
  output: "json" | "csv" | "markdown" | "text" | "tarball";
  grouping?: "consolidated" | "repeated";
  textStyle?: "attached" | "columns";
  recordSeparator?: "newline" | "space";
  specifierSeparator?: "comma" | "space";
  specifierMode?: "include" | "names-only";
  filter?: Partial<FormatFilter>;
};

export type FormatFilter = {
  exactVersions: boolean;
  semverRanges: boolean;
  distTags: boolean;
  packageOnly: boolean;
};

export type FormatCompatibility = {
  supported: boolean;
  reason?: string;
};

export type FormatExclusionCategory =
  | "dist-tag"
  | "exact-version"
  | "package-only"
  | "semver-range";

export type ExcludedFormatEntry = {
  name: string;
  specifier?: string;
  category: FormatExclusionCategory;
};

export type FormatSelection = {
  included: ParsedPackage[];
  excluded: ExcludedFormatEntry[];
};
