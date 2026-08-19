# Toolchain image for the #699 sandcastle prototype: the stock sandcastle
# image (node + git + gh + claude CLI) plus everything `make forgejo-test-unit`
# and `cargo test` need — Go 1.26 with cgo (go-sqlite3), rust stable via
# rustup (rust-toolchain.toml resolves the channel), and the C build deps
# jj-lib/sidecar crates link against.
#
# Build:  npx sandcastle docker build-image --dockerfile .sandcastle/Dockerfile.jjforge --image-name sandcastle-jjforge
# (build-args AGENT_UID/AGENT_GID are supplied by sandcastle on Linux)

FROM node:22-bookworm

# System deps: sandcastle's own (git, curl, jq) plus the jjforge toolchain's
# C half — build-essential/pkg-config for cgo and -sys crates, libssl-dev and
# cmake for sidecar dependencies.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  build-essential \
  pkg-config \
  libssl-dev \
  cmake \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (kept from the stock image; the prototype passes the issue via
# promptArgs instead, but the agent may still read linked issues)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Go 1.26 — copied from the official image rather than a hand-pinned tarball,
# so the patch level tracks the golang:1.26 tag
COPY --from=golang:1.26-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:$PATH"

# sccache — the shared rustc cache. Sandcastle bind-mounts SCCACHE_DIR from the
# host, so every sandbox reuses dependencies compiled by earlier ones instead of
# paying the cold Rust compile per turn. Unlike a shared cargo target/ this is
# safe to share concurrently: sccache shares a cache, not a build lock.
# A pinned release binary rather than `cargo install`, which would compile it
# from source on every image build.
ARG SCCACHE_VERSION=0.17.0
RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
  amd64) scc_arch=x86_64 ;; \
  arm64) scc_arch=aarch64 ;; \
  *) echo "sccache: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  scc_dir="sccache-v${SCCACHE_VERSION}-${scc_arch}-unknown-linux-musl"; \
  curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/${scc_dir}.tar.gz" \
  | tar xz -C /tmp; \
  install -m 0755 "/tmp/${scc_dir}/sccache" /usr/local/bin/sccache; \
  rm -rf "/tmp/${scc_dir}"; \
  sccache --version

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# rustup + the stable toolchain rust-toolchain.toml names, installed at build
# time so the first cargo invocation in a sandbox doesn't download a toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --component clippy --component rustfmt

ENV PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:/usr/local/go/bin:$PATH"

# Route rustc through sccache. CARGO_INCREMENTAL=0 is required, not cosmetic:
# sccache refuses to cache incremental compilations and cargo turns them on for
# dev builds by default, so leaving it unset silently forfeits caching of the
# workspace's own crates. Cache hits also depend on the build path matching
# across sandboxes — sandcastle always mounts the worktree at
# /home/agent/workspace, so they do.
ENV RUSTC_WRAPPER=/usr/local/bin/sccache \
  SCCACHE_DIR=/home/agent/.cache/sccache \
  SCCACHE_CACHE_SIZE=20G \
  CARGO_INCREMENTAL=0

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
ENTRYPOINT ["sleep", "infinity"]
