import type { SourceSpan } from "./types.js";

export type SourceLine = {
  start: number;
  end: number;
  text: string;
};

export type CsvField = {
  value: string;
  span: SourceSpan;
};

export type CsvRecord = {
  fields: CsvField[];
  malformedQuote?: SourceSpan;
};

export function span(input: string, start: number, end: number): SourceSpan {
  return { start, end, text: input.slice(start, end) };
}

export function trimSpan(input: string, start: number, end: number): SourceSpan {
  while (start < end && /\s/u.test(input[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(input[end - 1] ?? "")) end -= 1;
  return span(input, start, end);
}

export function scanLines(input: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  for (let index = 0; index <= input.length; index += 1) {
    if (index !== input.length && input[index] !== "\n") continue;
    const rawEnd = index;
    const end = rawEnd > start && input[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ start, end, text: input.slice(start, end) });
    start = index + 1;
  }

  return lines;
}

export function scanCsvRecord(
  input: string,
  start: number,
  end: number,
): CsvRecord {
  const fields: CsvField[] = [];
  let fieldStart = start;
  let index = start;

  while (index <= end) {
    const isEnd = index === end;
    if (!isEnd && input[index] !== ",") {
      if (input[index] === '"' && onlyWhitespace(input, fieldStart, index)) {
        const quoted = scanQuotedCsvField(input, fieldStart, index, end);
        if (quoted.malformedQuote) {
          return { fields, malformedQuote: quoted.malformedQuote };
        }
        fields.push(quoted.field);
        index = quoted.nextIndex;
        if (index === end && input[end - 1] !== ",") return { fields };
        fieldStart = index;
        continue;
      }
      index += 1;
      continue;
    }

    const fieldSpan = trimSpan(input, fieldStart, index);
    fields.push({ value: fieldSpan.text, span: fieldSpan });
    index += 1;
    fieldStart = index;
  }

  return { fields };
}

function scanQuotedCsvField(
  input: string,
  rawStart: number,
  quoteStart: number,
  end: number,
):
  | { field: CsvField; nextIndex: number; malformedQuote?: never }
  | { malformedQuote: SourceSpan; field?: never; nextIndex?: never } {
  let index = quoteStart + 1;
  let value = "";

  while (index < end) {
    if (input[index] !== '"') {
      value += input[index] ?? "";
      index += 1;
      continue;
    }
    if (input[index + 1] === '"') {
      value += '"';
      index += 2;
      continue;
    }

    const closeQuote = index;
    index += 1;
    while (index < end && /\s/u.test(input[index] ?? "")) index += 1;
    if (index < end && input[index] !== ",") {
      return { malformedQuote: span(input, quoteStart, index + 1) };
    }
    if (index < end) index += 1;

    return {
      field: {
        value,
        span: span(input, quoteStart + 1, closeQuote),
      },
      nextIndex: index,
    };
  }

  return { malformedQuote: span(input, rawStart, end) };
}

function onlyWhitespace(input: string, start: number, end: number): boolean {
  return input.slice(start, end).trim().length === 0;
}

export function splitOutsideQuotes(
  input: string,
  start: number,
  end: number,
  separator: "comma" | "whitespace" | "pipe",
): SourceSpan[] | undefined {
  const parts: SourceSpan[] = [];
  let quote: '"' | "'" | undefined;
  let partStart = start;
  let index = start;

  const pushPart = (partEnd: number): void => {
    const part = trimSpan(input, partStart, partEnd);
    if (part.text.length > 0) parts.push(part);
  };

  while (index < end) {
    const character = input[index];
    if (quote) {
      if (character === quote && input[index - 1] !== "\\") quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }

    const separates =
      separator === "pipe"
        ? character === "|" && input[index - 1] !== "\\"
        : separator === "comma"
          ? character === ","
          : /\s/u.test(character ?? "");
    if (!separates) {
      index += 1;
      continue;
    }

    pushPart(index);
    if (separator === "whitespace") {
      while (index < end && /\s/u.test(input[index] ?? "")) index += 1;
    } else {
      index += 1;
    }
    partStart = index;
  }

  if (quote) return undefined;
  pushPart(end);
  return parts;
}
