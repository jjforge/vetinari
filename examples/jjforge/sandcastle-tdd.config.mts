// Real config from the project this harness was extracted from — a Go fork plus
// a Rust sidecar, tasks sourced from GitHub issues.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "sandcastle-tdd";

export default defineConfig({
  project: "jjforge",
  image: "sandcastle-jjforge",
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
    { hostPath: ".sandcastle/cache/gomod", sandboxPath: "/home/agent/go/pkg/mod" },
    { hostPath: ".sandcastle/cache/gocache", sandboxPath: "/home/agent/.cache/go-build" },
    { hostPath: ".sandcastle/cache/cargo-registry", sandboxPath: "/home/agent/.cargo/registry" },
    { hostPath: ".sandcastle/cache/sccache", sandboxPath: "/home/agent/.cache/sccache" },
  ],

  fetchTask: (id) =>
    execFileSync("gh", ["issue", "view", id, "--repo", "jjforge/jjforge", "--json", "title,body,comments"], { encoding: "utf8" }),

  toolchainProbe: "go version && cargo --version && sccache --version && claude --version && git --version",

  // Sandcastle writes safe.directory host-side and needs a writable global git
  // config; this machine's real one is a read-only nix store symlink. It must
  // stay OUT of .sandcastle/.env — that file is injected into the container,
  // where any GIT_CONFIG_GLOBAL overrides the HOME the fork's own git tests
  // depend on, failing modules/git and models/asymkey.
  hostEnv: { GIT_CONFIG_GLOBAL: resolve(".sandcastle/gitconfig") },
});
