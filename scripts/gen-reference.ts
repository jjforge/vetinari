/**
 * Rewrite the generated "CLI modes" block of `docs/reference.md` from `MODES`
 * (src/help.ts) — the same source `--help` renders from, so the reference's mode
 * list can never drift from the CLI (design §13.3). Run it after changing `MODES`;
 * `help.test.ts` fails until the block on disk matches the renderer.
 *
 *   npm run gen-reference
 *
 * Everything outside the marker comments (config fields, on-disk layout, env
 * vars, event kinds, Telegram routing) is hand-written and left untouched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderModesReference,
  MODES_REFERENCE_BEGIN,
  MODES_REFERENCE_END,
} from "../src/help.ts";

const path = join(process.cwd(), "docs/reference.md");
const md = readFileSync(path, "utf8");

const start = md.indexOf(MODES_REFERENCE_BEGIN);
const end = md.indexOf(MODES_REFERENCE_END);
if (start < 0 || end <= start) {
  console.error(
    `docs/reference.md is missing the modes markers (${MODES_REFERENCE_BEGIN} … ${MODES_REFERENCE_END}); add them where the generated table belongs.`,
  );
  process.exit(1);
}

const next = md.slice(0, start) + renderModesReference() + md.slice(end + MODES_REFERENCE_END.length);
if (next === md) {
  console.log("docs/reference.md modes block already up to date.");
} else {
  writeFileSync(path, next);
  console.log("docs/reference.md modes block regenerated from MODES.");
}
