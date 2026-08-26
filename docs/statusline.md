# The Claude Code status line

`vetinari statusline` prints a compact view of a run into the Claude Code status
bar, so a campaign in flight is visible without leaving the editor. The README
covers wiring it in with one command; this is the rest: what each line carries,
how to wire it by hand, and how the install wraps a status line you already have.

## What it shows

Two lines. Line 1 mirrors Claude Code's own default (model, directory, git
branch, context-used %), with the model name trimmed of its `(1M context)`
suffix. Line 2 is the Vetinari run: the wave in flight and a count per status.
The 🏰 marks it, and there is no project name, since line 1 already shows the
directory:

```
Opus 4.8 · jjforge · develop · 24%
🏰 wave 2/3 · ✅2 🔄1 ⏸1 ⚪1
```

Outside a Vetinari project, line 2 is simply omitted, leaving line 1. A non-zero
exit would blank the whole bar, so `statusline` never errors out: any missing
piece just narrows what prints.

## Install

```bash
vetinari statusline install                      # default: npx vetinari statusline
vetinari statusline install --run-command ".vetinari.local/run statusline"
vetinari statusline install --dry-run            # print the plan, write nothing
vetinari statusline uninstall                    # restore what it wrapped
```

`install` edits the project's committed `.claude/settings.json`. It is
idempotent, and `--dry-run` prints the plan and writes nothing.

Pass `--run-command` to match however you invoke the CLI in your project, so the
`vetinari` import and the config both resolve. The default is
`npx vetinari statusline`; an in-repo launcher such as
`.vetinari.local/run statusline` is the common override.

### Wrapping a status line you already have

Install **respects a status line you already have**, including one set at the
user level in `~/.claude/settings.json`. Whatever is configured stays as line 1,
rendered exactly as it is (colours and all), and the 🏰 campaign line is added
*under* it, never replacing it, so a customized bar keeps working.

Under the hood, install base64-encodes your existing command into a `--base-b64`
suffix on the installed command; `vetinari statusline` runs that command for line
1 and appends its own campaign line, falling back to its own context line only
when yours produces nothing. When the project has no status line of its own, it
wraps the one inherited from `~/.claude/settings.json` (which a project-level
write would otherwise shadow, blanking its colours).

`uninstall` reverses it exactly: it restores your previous command, or drops the
project `statusLine` entirely when Vetinari wrapped nothing (or when what it
wrapped was the inherited user-level line, so the inheritance applies again).

> A `statusLine` set in the higher-precedence `.claude/settings.local.json` is
> not yet accounted for; a project-level install is shadowed by it. Tracked
> separately.

## Wiring it by hand

`install` just writes this entry; you can write it yourself instead:

```json
{
  "statusLine": { "type": "command", "command": ".vetinari.local/run statusline", "refreshInterval": 5 }
}
```

`refreshInterval` matters. Claude Code refreshes the status line on its own
events, but nothing tells it when the orchestrator's log changes; polling every
few seconds keeps the line live during a run.

## How line 2 stays fast

`statusline` reads Claude Code's JSON on stdin, resolves the config from the
workspace directory, and derives line 2 from the log alone, with no network, so
it stays cheap enough to run on every refresh. Line 1's fields come from Claude
Code's own stdin JSON (`model.display_name`, `workspace.current_dir`,
`context_window.used_percentage`) plus a `git` call for the branch.
