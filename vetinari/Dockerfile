# Starting point for a vetinari task image: node + git + gh + the resumable agent
# CLIs vetinari can drive — Claude Code, pi, and Codex (selectable per run with
# `--agent`, ADR 0016) — running as a non-root `agent` user whose UID/GID match the
# host's (sandcastle passes AGENT_UID/AGENT_GID when it builds).
#
# Credentials stay per-provider and user-supplied in `.vetinari.local/.env`:
#   claude → CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)
#   pi     → ANTHROPIC_API_KEY
#   codex  → OPENAI_API_KEY
# A run whose selected provider has no credential fails a preflight before launch.
#
# ADD YOUR PROJECT'S TOOLCHAIN — compilers, package managers, system libraries.
# The gates run inside this image, so anything your test command needs must be
# here. Prove it with `vetinari baseline` before running an agent.
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

# pi and Codex agent CLIs — installed globally as root, before the drop to the
# non-root agent user (Claude Code is installed below, as that user, via its own
# installer). Any of the three can drive a run; `--agent` selects which (ADR 0016).
RUN npm install -g @mariozechner/pi-coding-agent @openai/codex

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

# Matt Pocock's Claude Code skills, at PERSONAL scope so every task's agent
# auto-discovers them — sandcastle runs the plain `claude --print` CLI (no
# --bare) with HOME=/home/agent, and the CLI loads ~/.claude/skills/<name>/SKILL.md
# with no flag or setting. Personal scope keeps them out of your repo and off
# every agent branch.
#
# This mirrors the `mattpocock-skills` PLUGIN as installed on the host (v1.2.3):
# SKILLS_REF is that version's commit, and the exact skill set is read from the
# plugin's own `.claude-plugin/plugin.json` manifest — 25 curated skills, not
# every dir in the repo. The CLI has no plugin machinery here, so the skills are
# flattened to ~/.claude/skills/<name>/ (discovery is not recursive into the
# repo's category dirs). Bump SKILLS_REF to the new plugin commit to update, then
# rebuild and re-run `baseline`.
ARG SKILLS_REF=84fdeffd12f2ee307994d1eb6feb48173b6e0502
RUN git clone https://github.com/mattpocock/skills /tmp/mp-skills \
 && git -C /tmp/mp-skills checkout "$SKILLS_REF" \
 && mkdir -p /home/agent/.claude/skills \
 && jq -r '.skills[]' /tmp/mp-skills/.claude-plugin/plugin.json \
    | while read -r rel; do cp -a "/tmp/mp-skills/$rel" /home/agent/.claude/skills/; done \
 && rm -rf /tmp/mp-skills

WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace and sets it
# as the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
