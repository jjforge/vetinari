// A `fileSet` recipe for package-scoped languages (Go and similar), where every
// file in one directory shares a single package namespace.
//
// The planner keeps a wave's members file-disjoint, and that is its only co-wave
// guard. In Go, two tickets that touch *different* files in the *same* package
// still share one namespace, so each can add the same package-level identifier
// (`healthClass`, say). Each goes green alone; merged, they do not compile, and
// the merged-base gate goes red. File-disjoint is not compile-disjoint there.
//
// This resolver widens each fileKey the shipped `defaultFileSet` returns to its
// *directory*, so two tickets in one directory collide on the same key and the
// planner lands them in separate waves. The cost is fewer, larger-grained waves.
//
// Wire it in `vetinari/config.mts` as `fileSet: packageScopedFileSet()`.
import { dirname } from "node:path";
import { defaultFileSet, type FileSetOf } from "vetinari";

/**
 * A directory-scoped file-set resolver built on the shipped `defaultFileSet`.
 * Each fileKey the default returns is mapped to its directory (`dirname`) and
 * de-duplicated; `confident` is passed through unchanged. `root` is forwarded to
 * `defaultFileSet` (default: the cwd) so a test can point it at a temp tree.
 *
 * Note on bare and ambiguous cites: the resolver keeps a bare basename for a bare
 * `Creates:` cite, a `Creates:` cite whose directory matches several tree
 * directories, and a name the tree holds under several paths. Their `dirname` is
 * `.`, so they collide with every other bare key and every root-level file. That
 * is conservative: it serializes more, never less. Any other `Creates:` cite keys
 * under its resolved (or new) directory.
 */
export function packageScopedFileSet(root?: string): FileSetOf {
  const base = defaultFileSet(root);
  return (ticket: string) => {
    const { files, confident } = base(ticket);
    return { files: [...new Set(files.map((f) => dirname(f)))], confident };
  };
}
