export interface QuotePrefix {
  indentation: string;
  markers: string;
  text: string;
  depth: number;
}

const QUOTE_PREFIX_PATTERN = /^([ \t]*)((?:>[ \t]*)*> )(?![ \t]*>)/;

export function parseQuotePrefix(source: string): QuotePrefix | null {
  const match = QUOTE_PREFIX_PATTERN.exec(source);
  if (!match) {
    return null;
  }
  const indentation = match[1] ?? "";
  const markers = match[2] ?? "";
  return {
    indentation,
    markers,
    text: `${indentation}${markers}`,
    depth: markers.match(/>/g)?.length ?? 0,
  };
}
