// Real config from the project this harness was extracted from — a Go fork plus
// a Rust sidecar, tasks sourced from GitHub issues.
import { resolve } from "node:path";
import { defineConfig, githubBlockedBy, githubFetchTask, githubFindingReporter, githubIssueComment } from "vetinari";

export default defineConfig({
  project: "jjforge",
  image: "vetinari-jjforge",
  baseBranch: "develop",

  // The gate. The Go suite always; the Rust suite only when the branch touched
  // it, because its cold compile otherwise dominates every turn. `when` keeps
  // that scoping explicit and logged rather than hidden in a conditional.
  gates: [
    { cmd: "make forgejo-test-unit", label: "go-unit" },
    { cmd: "SQLX_OFFLINE=true cargo test --manifest-path sidecar/Cargo.toml", when: /^(sidecar|vendor\/jj)\//m, label: "rust" },
  ],

  // vendor/jj is a gitignored reference clone, so a fresh worktree lacks it and
  // anything compiling against jj-lib fails until this runs.
  setup: ["make jj-checkout"],

  // Go's module and build caches are concurrency-safe, so parallel sandboxes
  // share them: cold gate 2571s → warm 330s, measured. Cargo's target/ is
  // deliberately NOT shared — that is the build-lock contention containers are
  // here to avoid.
  //
  // sccache is how the Rust half gets the same reuse without that lock: it
  // shares a *cache*, so sandboxes hit each other's compiled dependencies and
  // still build in parallel. Measured on the host: three concurrent containers
  // against one warm cache, 100% hit rate, zero read/write errors. Requires the
  // RUSTC_WRAPPER/SCCACHE_DIR/CARGO_INCREMENTAL env set in the image.
  //
  // Container-only by design: sccache keys include the build path, and the host
  // builds this repo at a different path than the sandboxes' /home/agent/
  // workspace, so a host-shared cache would never produce cross-hits anyway.
  mounts: [
    { hostPath: ".vetinari.local/cache/gomod", sandboxPath: "/home/agent/go/pkg/mod" },
    { hostPath: ".vetinari.local/cache/gocache", sandboxPath: "/home/agent/.cache/go-build" },
    { hostPath: ".vetinari.local/cache/cargo-registry", sandboxPath: "/home/agent/.cargo/registry" },
    { hostPath: ".vetinari.local/cache/sccache", sandboxPath: "/home/agent/.cache/sccache" },
  ],

  // The shared helper fetches the full field set — title/body/comments/labels for
  // the prompt, plus state/closedAt so `issueStateFromTask` can reject a closed graft
  // target (#175). Hand-rolling the `--json` list here would silently re-drop those.
  fetchTask: githubFetchTask("jjforge/jjforge"),

  // Powers `carve`: native GitHub "blocked by" links tell it which issues fall
  // when one is pulled from a campaign.
  blockedBy: githubBlockedBy("jjforge/jjforge"),

  // After a green run, harvest defects the agent noticed but did not fix and file
  // them as issues — otherwise that context dies with the container. Same label
  // discipline the interactive /fix-issue command uses.
  reportFinding: githubFindingReporter("jjforge/jjforge", { labels: ["P2", "bug", "needs-triage"] }),

  // Relays a parked question's answer to a non-resumable agent (copilot/cursor/opencode):
  // `answer` posts the human's reply as an issue comment, then re-runs fresh so the next
  // turn's fetchTask re-reads it. Resumable agents resume their session instead and never
  // call this (#212).
  postComment: githubIssueComment("jjforge/jjforge"),

  toolchainProbe: "go version && cargo --version && sccache --version && claude --version && git --version",

  // Sandcastle writes safe.directory host-side and needs a writable global git
  // config; this machine's real one is a read-only nix store symlink. It must
  // stay OUT of .vetinari.local/.env — that file is injected into the container,
  // where any GIT_CONFIG_GLOBAL overrides the HOME the fork's own git tests
  // depend on, failing modules/git and models/asymkey.
  hostEnv: { GIT_CONFIG_GLOBAL: resolve(".vetinari.local/gitconfig") },
});
