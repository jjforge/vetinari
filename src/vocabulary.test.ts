import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The retired conflict-hold vocabulary (`quarantined`, `waveParked`) is gone from the
 * code (design §13.1, §13.2): the parked-conflict set is `conflictParked`, a red merged
 * base wave-parks the campaign, and `tidy`'s keep-reasons read `parked(conflict)` /
 * `campaign-parked`. The single exception is the alias table in `event-log.ts`, which
 * translates archived logs written in the old event names — "the one and only place the
 * retired names appear" (§13.2). Test files may name the archived events as fixtures, so
 * this scans only the non-test sources.
 */
test("no retired quarantine/waveParked identifier survives in the sources (design §13.1)", () => {
  const allow = new Set(["event-log.ts"]);
  const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !allow.has(f));
  for (const file of sources) {
    const text = readFileSync(join(SRC, file), "utf8");
    assert.ok(!/quarantin/i.test(text), `${file} still mentions the retired 'quarantine' vocabulary`);
    assert.ok(!/waveParked/.test(text), `${file} still carries a 'waveParked' identifier`);
  }
});
