import { type HTMLAttributes, useMemo } from "react";
import { type JsonTokenKind, tokenizeJson } from "@/lib/json-highlight";
import { cn } from "@/lib/utils";

// Each token kind resolves to a theme variable (defined in index.css) so the
// palette repaints with the light/dark toggle like every other surface.
const tokenClass: Record<JsonTokenKind, string> = {
  key: "text-[var(--json-key)]",
  string: "text-[var(--json-string)]",
  number: "text-[var(--json-number)]",
  boolean: "text-[var(--json-boolean)]",
  null: "text-[var(--json-null)]",
  punctuation: "text-[var(--json-punctuation)]",
};

type JsonViewProps = Omit<HTMLAttributes<HTMLPreElement>, "children"> & {
  value: unknown;
};

/** Render a value as syntax-highlighted, pretty-printed JSON. */
export function JsonView({ value, className, ...props }: JsonViewProps) {
  const tokens = useMemo(() => tokenizeJson(value), [value]);

  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-md border border-border bg-background p-3 text-xs",
        className,
      )}
      {...props}
    >
      <code>
        {tokens.map((token, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are a stable, ordered render of one immutable document
          <span key={index} className={tokenClass[token.kind]}>
            {token.value}
          </span>
        ))}
      </code>
    </pre>
  );
}
