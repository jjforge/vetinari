# Starting point for a sandcastle-tdd task image: node + git + gh + the Claude
# Code CLI, running as a non-root `agent` user whose UID/GID match the host's
# (sandcastle passes AGENT_UID/AGENT_GID when it builds).
#
# ADD YOUR PROJECT'S TOOLCHAIN — compilers, package managers, system libraries.
# The gates run inside this image, so anything your test command needs must be
# here. Prove it with `sandcastle-tdd baseline` before running an agent.
#
# Build:
#   npx sandcastle docker build-image --dockerfile <this file> --image-name <name>

FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI — needed if your fetchTask or agent reads issues in-container.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# --- your toolchain goes here -------------------------------------------------
# e.g. COPY --from=golang:1.26-bookworm /usr/local/go /usr/local/go
#      ENV PATH="/usr/local/go/bin:$PATH"
# ------------------------------------------------------------------------------

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace and sets it
# as the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
