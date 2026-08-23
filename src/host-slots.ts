/**
 * The host slot budget (ADR 0010): a cooperative filesystem lease every
 * `campaign`/`queue` run reads and writes directly so the sum of live containers
 * across every project stays within a host-side ceiling. Split into a pure
 * fair-share computation and the impure lease edge; the gateway never allocates.
 */

/**
 * A project's currently-allowed slot count under a `budget`, given the weights of
 * every currently-active project: a floor of one slot per active project plus a
 * weight-proportional cut of the remainder. Pure — no filesystem. A project alone
 * gets the whole budget; each active project always gets at least one while the
 * budget can seat them all.
 */
export function fairShare(budget: number, activeWeights: Record<string, number>, project: string): number {
  const projects = Object.keys(activeWeights);
  const n = projects.length;
  if (budget <= 0 || n === 0 || !(project in activeWeights)) return 0;

  // Over-subscription: the machine cannot seat one slot for every active project,
  // so the floor is best-effort — the heaviest `budget` projects get their one
  // slot and the rest get none (they wait first-come for a freed slot). Ties
  // broken by name so every run agrees on who is seated.
  if (budget < n) {
    const seated = [...projects]
      .sort((x, y) => activeWeights[y] - activeWeights[x] || (x < y ? -1 : 1))
      .slice(0, budget);
    return seated.includes(project) ? 1 : 0;
  }

  // Everyone gets a floor of one, then the remainder is cut weight-proportionally
  // by the largest-remainder (Hamilton) method: each project's base is the floor
  // of its ideal cut, and the leftover slots go to the largest fractional parts,
  // ties broken by project name so every run computes the identical split.
  const remainder = budget - n;
  const totalWeight = projects.reduce((s, p) => s + activeWeights[p], 0) || 1;
  const ideal = (p: string) => (remainder * activeWeights[p]) / totalWeight;
  const base = (p: string) => Math.floor(ideal(p));
  let leftover = remainder - projects.reduce((s, p) => s + base(p), 0);
  const byFraction = [...projects].sort((x, y) => {
    const fx = ideal(x) - base(x);
    const fy = ideal(y) - base(y);
    return fy - fx || (x < y ? -1 : 1);
  });
  const bonus = new Set(byFraction.slice(0, leftover));
  return 1 + base(project) + (bonus.has(project) ? 1 : 0);
}
