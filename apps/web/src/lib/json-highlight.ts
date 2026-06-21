/** A single coloured run of a pretty-printed JSON document. */
export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation";

export interface JsonToken {
  value: string;
  kind: JsonTokenKind;
}

const NUMBER_START = /[-\d]/;
const NUMBER_BODY = /[\d.eE+-]/;

/** Index after a quoted run starting at `from` (handling backslash escapes). */
function endOfString(json: string, from: number): number {
  let i = from + 1;
  while (i < json.length) {
    if (json[i] === "\\") {
      i += 2;
      continue;
    }
    if (json[i] === '"') return i + 1;
    i += 1;
  }
  return i;
}

/** True when the quoted run ending at `end` is followed by a `:` (an object key). */
function isKey(json: string, end: number): boolean {
  let i = end;
  while (i < json.length && (json[i] === " " || json[i] === "\n")) i += 1;
  return json[i] === ":";
}

/** True when a bare value token (number/boolean/null) begins at `i`. */
function startsValue(json: string, i: number): boolean {
  return (
    NUMBER_START.test(json.charAt(i)) ||
    json.startsWith("true", i) ||
    json.startsWith("false", i) ||
    json.startsWith("null", i)
  );
}

/** Index after the run of punctuation/whitespace starting at `from`. */
function endOfPunctuation(json: string, from: number): number {
  let i = from + 1;
  while (i < json.length && json[i] !== '"' && !startsValue(json, i)) i += 1;
  return i;
}

/** The bare literal (`true`/`false`/`null`) at `i`, or `undefined` if none. */
function literalAt(json: string, i: number): JsonToken | undefined {
  if (json.startsWith("true", i)) return { value: "true", kind: "boolean" };
  if (json.startsWith("false", i)) return { value: "false", kind: "boolean" };
  if (json.startsWith("null", i)) return { value: "null", kind: "null" };
  return undefined;
}

/** Index after the numeric run starting at `from`. */
function endOfNumber(json: string, from: number): number {
  let i = from + 1;
  while (i < json.length && NUMBER_BODY.test(json.charAt(i))) i += 1;
  return i;
}

/** Read the single token beginning at `i`; its `value.length` is how far to advance. */
function readToken(json: string, i: number): JsonToken {
  const ch = json.charAt(i);
  if (ch === '"') {
    const end = endOfString(json, i);
    return { value: json.slice(i, end), kind: isKey(json, end) ? "key" : "string" };
  }
  if (NUMBER_START.test(ch)) {
    return { value: json.slice(i, endOfNumber(json, i)), kind: "number" };
  }
  const literal = literalAt(json, i);
  if (literal) return literal;
  return { value: json.slice(i, endOfPunctuation(json, i)), kind: "punctuation" };
}

/**
 * Split a value's `JSON.stringify(…, null, 2)` rendering into coloured tokens.
 *
 * The scanner walks the formatted text once: quoted runs become `key` when the
 * next significant character is a `:` and `string` otherwise, bare literals
 * become `number`/`boolean`/`null`, and everything else (braces, commas,
 * colons, whitespace) is carried verbatim as `punctuation`. Concatenating every
 * token's `value` reproduces the original `JSON.stringify` output exactly, so
 * the rendered view stays copy-paste faithful.
 */
export function tokenizeJson(value: unknown): JsonToken[] {
  const json = JSON.stringify(value, null, 2) ?? "";
  const tokens: JsonToken[] = [];
  let i = 0;

  while (i < json.length) {
    const token = readToken(json, i);
    tokens.push(token);
    i += token.value.length;
  }

  return tokens;
}
