// Real config from the project this harness was extracted from — a Go fork plus
// a Rust sidecar, tasks sourced from GitHub issues.
import { defineConfig, githubTracker } from "vetinari";

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

  // The GitHub tracker preset: fetchTask, blockedBy, listByLabel, postComment,
  // onIssueMerged and reportFinding, all against this repo's `origin`. Findings an agent
  // noticed but did not fix are filed with the same label discipline the interactive
  // /fix-issue command uses.
  ...githubTracker({ findingLabels: ["P2", "bug", "needs-triage"] }),

  toolchainProbe: "go version && cargo --version && sccache --version && claude --version && git --version",
});
