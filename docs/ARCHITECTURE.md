# Architecture

Read this before your first PR. It explains what actually happens when you run `tyr <command>`.

## The pipeline: Kernel → Container → TyrContext → Commands

Every invocation follows the same path:

1. **Kernel boots.** `bin/tyr.ts` creates one `Kernel` (`src/core/Kernel.ts`) and calls `boot(args)`.
   Boot strips a global `--debug` flag, loads `~/.tyr/.env`, initializes the `Container`, and loads
   `~/.tyr/map.yml` into memory.
2. **Container builds every Manager.** `Container.init()` (`src/core/Container.ts`) constructs each
   Manager exactly once — `ShellManager`, `FileSystemManager`, `GitManager`, `AIVendorManager`, and
   so on — wiring their constructor dependencies by hand (e.g. `GitManager` needs a `ShellManager`
   and a `Logger`). This happens once per process, no matter how many commands run.
3. **Kernel resolves the command and builds a `TyrContext`.** `Kernel.handle(args)` looks at
   `args[0]` and checks it against, in order: a handful of hardcoded flags (`--version`, `--update`,
   `--upgrade`, `--help`), the config/module-management flags (`--config`, `--modules`, `--add`,
   `--del`, `--manifest`), the four built-in system commands (`gen`, `rem`, `doc`, `chat`, in
   `src/core/sys/`), and finally `map.yml`'s `commands` table (resolving aliases along the way).
   Before any of the latter three groups run, it assembles a `TyrContext`: every Manager from the
   Container, spread together with `frameworkRoot`, `userRoot`, and three framework-level helpers —
   `run` (invoke another command programmatically), `task` (wrap risky work with error context), and
   `fail` (abort with a formatted, suggestion-carrying error).
4. **The command runs.** A command file is a default export shaped like
   `(context: TyrContext) => (args: string[]) => Promise<void>` — a factory that receives the
   context once, and returns the actual handler. `src/core/sys/gen.ts` is the most heavily
   commented example of this shape; copy its structure for new commands.

## `map.yml`: command names → files

`~/.tyr/map.yml` is a flat YAML map of `commands: { name: ./relative/or/absolute/path.ts }`, plus
an optional `aliases` map. `tyr gen <name> <file>` scaffolds a new command under
`~/.tyr/commands/<file>.tyr.ts` and adds an entry here; `tyr rem <name>` does the reverse. The
Kernel resolves any command name not matched by a built-in against this table.

## The module/manifest system

Third parties can distribute commands as a `manifest.json` (command name → raw file URL) instead of
a repository to clone. `tyr --add <url>` registers it in `~/.tyr/imported_modules.yaml` and
downloads the referenced files into `~/.tyr/commands/`, adding them to `map.yml` exactly like a
hand-written command — the Kernel doesn't distinguish the two at resolution time. A separate lockfile,
`~/.tyr/imported_modules.lock.yml`, tracks which module "owns" which command, so `tyr --update`
(refresh) and `tyr --del` (uninstall) only ever touch files they installed, never a hand-written
command that happens to share a name. `src/core/sys/modules.ts` implements all of this and is the
best place to see the full lifecycle: `addModule` → `syncModules` → `removeModule`.
