import type { ParkReason } from "./state.ts";

/**
 * The one move each park reason asks of the human (user guide park reasons, glossary
 * **conflict** / **Fix forward**) — shared by the CLI, the gateway, the campaign report, the
 * outbound notices, the merge record and the dashboard sheet, so no surface can drift from
 * another. Keyed by `ParkReason`, so a new reason does not compile until it has a move.
 *
 * Each value is a lower-case phrase with no trailing period, commands in backticks, `<id>`
 * where the issue id belongs. A per-issue surface renders it with {@link recoverySentence};
 * a campaign-level line wraps the phrase in its own `recover:` framing.
 */
export const PARK_RECOVERY: Record<ParkReason, string> = {
  question: "answer it",
  stalled: "read the turn log, then answer with guidance or `vetinari prune <id>`",
  conflict: "resolve the conflict on the base, then `vetinari redrive`",
  "red-base": "fix forward on the base, then `vetinari redrive`",
  crash: "`vetinari redrive`",
  stopped: "`vetinari redrive` to resume the campaign, or `vetinari run <id>` for a standalone run",
  "outdated-agent": "rebuild the image with `vetinari build`, then `vetinari redrive`",
};

/**
 * A {@link PARK_RECOVERY} move as a sentence about one issue: `<id>` replaced by `issue`, the
 * first letter upper-cased (a leading backtick is left as is), and a closing period.
 *
 * Shipped to the dashboard via `.toString()` like `reasonWord`, so it must stay
 * self-contained: no imports, no closures over module scope.
 */
export function recoverySentence(move: string, issue: string): string {
  const named = move.split("<id>").join(issue);
  return named.charAt(0).toUpperCase() + named.slice(1) + ".";
}
