/** Statute + CUAD slugs pinned for cofounder / restricted-stock counsel (ingested corpus). */
export const COFOUNDER_STATUTE_SLUGS = [
  "irc-1202",
  "irc-83b",
  "irc-409a",
  "dgcl-144",
  "dgcl-102",
  "cuad-ip-assignment-prior-inventions",
  "cuad-ip-assignment-scoped",
  "cuad-coc-acceleration",
  "cuad-indemnification-do",
  "cuad-termination-for-cause",
] as const;

export type CofounderStatuteSlug = (typeof COFOUNDER_STATUTE_SLUGS)[number];
