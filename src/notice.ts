import type { MessageCategory } from "./config.ts";

/**
 * One outbound notice, ready for the outbox (§2.6). `event` is the §2.1 routing
 * key the notify map keys on (`category:event`); it is omitted for a notice that
 * routes on category alone.
 */
export interface Notice {
  category: MessageCategory;
  event?: string;
  text: string;
}

/**
 * The one §10 notice skeleton every outbound notice renders: a header
 * `<emoji> <project> · <STATE> · <context>`, one signal line, and — where a park
 * or failure gives one — the exact recovery command (`vetinari redrive`,
 * `answer <id>`, `prune <id>`). One place so every notice speaks the settled
 * vocabulary (§13.1) and no retired word (`wave-park`, `quarantine`, `batch`,
 * `queue`, `--resume`) can reach an operator through a hand-rolled string.
 *
 * `recover` renders as a trailing `Recover: …` line only when a recovery command
 * exists; `detail` is an optional free-form tail (a gate report, an impact list)
 * hung under the skeleton after a blank line.
 */
export function notice(spec: {
  emoji: string;
  project: string;
  state: string;
  context: string;
  signal: string;
  recover?: string;
  detail?: string;
  category: MessageCategory;
  event?: string;
}): Notice {
  const lines = [
    `${spec.emoji} ${spec.project} · ${spec.state} · ${spec.context}`,
    spec.signal,
  ];
  if (spec.recover) lines.push(`Recover: ${spec.recover}`);
  let text = lines.join("\n");
  if (spec.detail) text += `\n\n${spec.detail}`;
  const out: Notice = { category: spec.category, text };
  if (spec.event) out.event = spec.event;
  return out;
}
