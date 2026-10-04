/**
 * How an issue is spelled: the shared id vocabulary. Pure string helpers with
 * **zero imports**, so this module sits below everything and can never take part
 * in an import cycle — the reason the id vocabulary lives here rather than in a
 * command module (`prune.ts`) that half the graph would then have to import.
 */

/** An id with a single leading `#` stripped and surrounding whitespace trimmed. */
export const normalize = (id: string) => id.replace(/^#/, "").trim();

/** An id rendered as `#n` — any spelling (`640`, `#640`, a number) prints the same. */
export const hash = (id: unknown) => "#" + normalize(String(id));

/**
 * A bare, numeric issue token (`640` or `#640`) — the shape every surface uses to
 * tell an issue id apart from a project qualifier (a non-numeric name).
 */
export const isIssueToken = (t: string) => /^#?\d+$/.test(t);
