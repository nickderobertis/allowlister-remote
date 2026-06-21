import { describe, expect, it } from "vitest";
import { type JsonTokenKind, tokenizeJson } from "./json-highlight";

/** Collapse tokens back into the pretty-printed source they were split from. */
function reassemble(value: unknown): string {
  return tokenizeJson(value)
    .map((token) => token.value)
    .join("");
}

/** The kind assigned to the first token whose text matches `text`. */
function kindOf(value: unknown, text: string): JsonTokenKind | undefined {
  return tokenizeJson(value).find((token) => token.value === text)?.kind;
}

describe("tokenizeJson", () => {
  it("reproduces the JSON.stringify output exactly when reassembled", () => {
    const value = {
      owner: "acme",
      attempts: 3,
      ratio: -1.5e2,
      enabled: true,
      disabled: false,
      note: null,
      nested: { items: ["a", 1, false] },
    };
    expect(reassemble(value)).toBe(JSON.stringify(value, null, 2));
  });

  it("classifies object keys distinctly from string values", () => {
    const tokens = tokenizeJson({ title: "Production is down" });
    expect(kindOf({ title: "x" }, '"title"')).toBe("key");
    expect(tokens.find((t) => t.value === '"Production is down"')?.kind).toBe("string");
  });

  it("classifies numbers, booleans, and null", () => {
    expect(kindOf({ n: 42 }, "42")).toBe("number");
    expect(kindOf({ n: -1.5e2 }, "-150")).toBe("number");
    expect(kindOf({ b: true }, "true")).toBe("boolean");
    expect(kindOf({ b: false }, "false")).toBe("boolean");
    expect(kindOf({ b: null }, "null")).toBe("null");
  });

  it("treats braces, colons, and whitespace as punctuation", () => {
    const kinds = new Set(tokenizeJson({ a: 1 }).map((t) => t.kind));
    expect(kinds.has("punctuation")).toBe(true);
  });

  it("keeps reserved words and digits inside strings as string content", () => {
    expect(kindOf({ a: "true 42 null" }, '"true 42 null"')).toBe("string");
  });

  it("handles escaped quotes within strings", () => {
    const value = { say: 'he said "hi"' };
    expect(reassemble(value)).toBe(JSON.stringify(value, null, 2));
    expect(kindOf(value, JSON.stringify('he said "hi"'))).toBe("string");
  });

  it("returns no tokens for values JSON.stringify drops", () => {
    expect(tokenizeJson(undefined)).toEqual([]);
  });
});
