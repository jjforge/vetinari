/**
 * Scaffold a NEW project onto the committed `sandcastle/` + excluded
 * `.sandcastle.local/` layout (ADR 0001, ADR 0003).
 *
 * Sibling of `migrate` and built on the same planner+apply shape: `migrate` moves
 * an existing project off the old layout, `init` stands a greenfield one up.
 * `computeInit` turns a described target directory into a plan — the files/dirs to
 * create and the `.gitignore` edit — touching nothing; `applyInit` performs that
 * plan against a real directory. sandcastle-tdd is a shared machine install, so
 * `init` lays down files only: it installs and vendors nothing.
 *
 * Idempotent and non-clobbering: re-running yields an empty plan and a "nothing to
 * do" report, and an existing `sandcastle/` config is never overwritten — the
 * committed scaffold is refused with a clear message while the still-missing
 * machine-local pieces (the excluded dir, the `.gitignore` entry) are filled in
 * without disturbing what already exists.
 */

const CANONICAL_DIR = "sandcastle";
const LOCAL_DIR = ".sandcastle.local";
const CONFIG_DEST = `${CANONICAL_DIR}/config.mts`;
const DOCKERFILE_DEST = `${CANONICAL_DIR}/Dockerfile`;

/** A file to write: its path relative to the project root and its full content. */
export interface FileCreate {
  path: string;
  content: string;
}

/**
 * A description of the relevant on-disk state, produced by the CLI at the edge so
 * the planner stays pure. Carries the template contents (read from the install)
 * that the committed scaffold is made of.
 */
export interface InitScan {
  /** Whether a canonical `sandcastle/` config already exists (→ scaffold refused). */
  hasConfig: boolean;
  /** Whether the excluded `.sandcastle.local/` dir already exists. */
  hasLocalDir: boolean;
  /** Current `.gitignore` content, or undefined when there is no `.gitignore`. */
  gitignore?: string;
  /** The `defineConfig` skeleton to write, shipped with the install. */
  configTemplate: string;
  /** The Dockerfile template to write, shipped with the install. */
  dockerfileTemplate: string;
}

export interface InitPlan {
  /** Committed scaffold files to write (the config skeleton and the Dockerfile). */
  creates: FileCreate[];
  /** Directories to create (the excluded `.sandcastle.local/`). */
  dirs: string[];
  /** The full new `.gitignore` content to write, or undefined when unchanged. */
  gitignore?: string;
  /**
   * True when a `sandcastle/` config already existed, so the committed scaffold
   * (config + Dockerfile) was withheld rather than overwritten. The machine-local
   * pieces are still filled in.
   */
  refused: boolean;
}

/**
 * Ensure `.gitignore` excludes the machine-local dir. Returns the full new content,
 * or undefined when the entry is already present (matched with or without a
 * trailing slash, so a re-run adds nothing).
 */
function planGitignore(current: string | undefined): string | undefined {
  const lines = (current ?? "").split("\n");
  const has = lines.some((l) => l.trim().replace(/\/$/, "") === LOCAL_DIR);
  if (has) return undefined;

  let out = current ?? "";
  if (out.length && !out.endsWith("\n")) out += "\n";
  return `${out}${LOCAL_DIR}/\n`;
}

/**
 * Pure planner: from a described target directory, return what `init` would create
 * and the `.gitignore` edit. Writes nothing. When a config already exists the
 * committed scaffold is withheld (`refused`) so it is never overwritten, while the
 * still-missing machine-local pieces are planned so a partial layout is topped up.
 */
export function computeInit(scan: InitScan): InitPlan {
  const creates: FileCreate[] = [];
  const dirs: string[] = [];
  const refused = scan.hasConfig;

  if (!refused) {
    creates.push({ path: CONFIG_DEST, content: scan.configTemplate });
    creates.push({ path: DOCKERFILE_DEST, content: scan.dockerfileTemplate });
  }
  if (!scan.hasLocalDir) dirs.push(LOCAL_DIR);

  const gitignore = planGitignore(scan.gitignore);

  return { creates, dirs, gitignore, refused };
}
