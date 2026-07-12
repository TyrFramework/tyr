/**
 * @fileoverview The Kernel is the framework's execution engine and the root of the
 * Kernel → Container → TyrContext → Commands pipeline: every `tyr <command>` invocation boots
 * exactly one Kernel instance (see bin/tyr.ts), which then:
 *
 *  1. Loads `~/.tyr/map.yml` (user-defined `commands`/`aliases`, distinct from the framework's own
 *     built-ins below) and the user's `~/.tyr/.env`.
 *  2. Initialises the {@link Container}, which instantiates every Manager once.
 *  3. Builds a {@link TyrContext} for the invocation: the Container's services plus `run`/`task`/
 *     `fail`/`frameworkRoot`/`userRoot`.
 *  4. Resolves the command name — first against a handful of hardcoded flags (`--config`,
 *     `--modules`, `--add`, `--del`, `--manifest`), then against the built-in system commands
 *     (`gen`, `rem`, `doc`, `chat` — see `./sys/*`), and finally against `map.yml`'s `commands`
 *     table, which point at arbitrary `.tyr.ts` files (typically under `~/.tyr/commands/`) — and
 *     invokes it with the context.
 *
 * Commands never construct a Kernel, Container or TyrContext themselves: they simply export a
 * `(context: TyrContext) => (args: string[]) => Promise<void>` factory (see `./sys/gen.ts` for a
 * heavily-annotated example) and let the Kernel supply everything.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir } from 'os';
import { Container } from './Container';

import gen from './sys/gen';
import rem from './sys/rem';
import doc from './sys/doc';
import chat from './sys/chat';
import config from './sys/config';
import help from './sys/help';
import modulesCommand, { syncModules } from './sys/modules';

import { TyrError } from './TyrError';

/** Shape of `~/.tyr/map.yml`: the user's registered command names mapped to the `.tyr.ts` file
 *  that implements each one, plus optional alias names that resolve to another command. */
interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

/**
 * The object every Tyr command receives as its sole argument. Built once per invocation by
 * {@link Kernel.handle} from the {@link Container}'s services plus the four framework-level
 * members declared explicitly below (`frameworkRoot`, `userRoot`, `run`, `task`, `fail`) — see
 * `[key: string]: any` for why Managers (e.g. `shell`, `fs`, `git`) are not enumerated here too.
 */
export interface TyrContext {
    /** Absolute path to the Tyr framework installation itself (this repository / npm package),
     *  resolved once in the Kernel constructor from `__dirname`. */
    frameworkRoot: string;
    /** Absolute path to the user's Tyr home, `~/.tyr` — where `map.yml`, `commands/`, `.env` and
     *  imported modules live. */
    userRoot: string;
    /** Programmatically invokes another registered command by name, as if it had been typed on
     *  the CLI, enabling command composition. Internally just re-enters {@link Kernel.handle}. */
    run: (commandName: string, args?: string[]) => Promise<void>;
    /** Wraps a unit of work so a thrown error is caught, given a human-readable `description` and
     *  re-thrown as a {@link TyrError} with framework-standard formatting — removing the need for
     *  commands to hand-write try/catch around every risky step. Pass `next: true` to swallow the
     *  error instead of propagating it (optionally running `onFail` first). */
    task: <T>(description: string, action: () => Promise<T> | T, next?: boolean, onFail?: () => void) => Promise<T | undefined>;
    /** Immediately aborts the running command by throwing a {@link TyrError} tagged with the
     *  current command name, optionally carrying a `suggestion` shown to the user. Never returns
     *  (typed `never`) so callers can use it in expression position, e.g. `x ?? fail('missing x')`. */
    fail: (msg: string, suggestion?: string) => never;
    /** Every Manager from {@link ServiceContainer} (`shell`, `fs`, `git`, `aiVendor`, ...) is also
     *  present here, spread in from `Container.get()`. Kept as an index signature rather than
     *  `& ServiceContainer` because a handful of call sites (see Kernel.handle's `--update`/
     *  `--help` bootstrap contexts) construct a partial, Manager-only context before the full one
     *  exists. */
    [key: string]: any;
}

type CommandFunction = (args: string[]) => Promise<void>;
/** What every command file's default export must be: given the context, return the actual
 *  handler. Splitting construction (`factory(context)`) from execution (`handler(args)`) is what
 *  lets the Kernel build one shared context per invocation and pass it to whichever command was
 *  requested, without every command file needing to know how that context is assembled. */
type CommandFactory = (context: TyrContext) => CommandFunction;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @class Kernel
 * @description The framework's execution engine. One instance is created and `boot()`ed per CLI
 * invocation (see bin/tyr.ts); see the file-level comment above for the full request lifecycle.
 */
export class Kernel {
    private container: Container;
    private config: TyrConfig | null;
    private frameworkRoot: string;
    private userRoot: string;
    private isDebug: boolean = false;

    constructor() {
        this.container = new Container();
        this.config = null;
        this.frameworkRoot = path.resolve(__dirname, '../../');
        this.userRoot = path.join(homedir(), '.tyr');
    }

    /**
     * @method boot
     * @description Prepares the Kernel before any command can run: strips the global `--debug`
     * flag (if present) from `args`, loads `~/.tyr/.env`, initialises the {@link Container} (which
     * constructs every Manager), and loads `~/.tyr/map.yml` into `this.config`. Must be called
     * exactly once, before the first `handle()` call.
     * @param {string[]} args - Raw CLI arguments (including a possible `--debug` flag).
     * @example
     * const kernel = new Kernel();
     * await kernel.boot(process.argv.slice(2));
     */
    public async boot(args: string[]): Promise<void> {
        this.isDebug = args.includes('--debug');
        
        if (this.isDebug) {
            args.splice(args.indexOf('--debug'), 1);
        }

        (dotenv as any).config({ path: path.join(this.userRoot, '.env'), quiet: true });

        await this.container.init(this.isDebug);

        this.config = { commands: {}, aliases: {} };

        const userConfigPath = path.join(this.userRoot, 'map.yml');
        if (fs.existsSync(userConfigPath)) {
            try {
                const raw = yaml.load(fs.readFileSync(userConfigPath, 'utf8')) as TyrConfig;
                for (const [name, cmdPath] of Object.entries(raw.commands ?? {})) {
                    this.config.commands[name] = path.isAbsolute(cmdPath)
                        ? cmdPath
                        : path.resolve(this.userRoot, cmdPath);
                }
                this.config.aliases = raw.aliases ?? {};
            } catch {
                console.error(`Warning: could not load user config at ${userConfigPath}`);
            }
        }
    }

    /**
     * @method handle
     * @description Resolves and runs a single command invocation. Handles, in order: no command
     * (prints usage), the hardcoded flags (`--version`, `--update`, `--upgrade`, `--help`), builds
     * the full {@link TyrContext} for everything after that point, then the config/module-management
     * flags (`--config`, `--modules`, `--add`, `--del`, `--manifest`), then the built-in system
     * commands (`gen`, `rem`, `doc`, `chat`), and finally user commands registered in
     * `~/.tyr/map.yml` (resolving aliases first). Also used internally by `TyrContext.run()` to
     * implement command composition — it simply re-enters this method.
     * @param {string[]} args - CLI arguments with the command name in `args[0]` (must not include
     *   `--debug`, which is stripped in `boot()`).
     * @example
     * await kernel.handle(['greet', 'World']);
     */
    public async handle(args: string[]): Promise<void> {
        const commandName = args[0];

        if (!commandName) {
            console.log('Usage: tyr <command> [args...]');
            console.log('       tyr --config     Configure Tyr for the first time');
            console.log('       tyr --version    Show version');
            console.log('       tyr --update     Pull latest changes from the linked ~/.tyr repo and refresh imported modules');
            console.log('       tyr --upgrade    Upgrade Tyr to the latest npm version');
            console.log('       tyr --modules    List or sync imported modules');
            console.log('       tyr --add <url>  Register and sync a manifest.json as an imported module');
            console.log('       tyr --del <name> Unregister an imported module and remove its commands');
            console.log('       tyr --manifest   Generate ~/.tyr/manifest.json from your commands (requires a GitHub-linked repo)');
            return;
        }

        if (commandName === '--version' || commandName === '-v') {
            const pkgPath = path.resolve(this.frameworkRoot, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            console.log(`tyr v${pkg.version}`);
            return;
        }

        if (commandName === '--update') {
            const shell = this.container.get().shell;
            const gitDir = path.join(this.userRoot, '.git');

            if (fs.existsSync(gitDir)) {
                console.log('Updating ~/.tyr from repository...');
                shell.cd(this.userRoot);
                await shell.exec('git pull');
                console.log('Repository update complete.');
            } else {
                console.log('~/.tyr is not linked to any git repository. Skipping git pull.');
                console.log('Run: tyr --config --repo <url>  to link it.');
            }

            const modulesPath = path.join(this.userRoot, 'imported_modules.yaml');
            if (fs.existsSync(modulesPath)) {
                console.log('\nUpdating imported modules...');
                const updateContext = {
                    ...this.container.get(),
                    frameworkRoot: this.frameworkRoot,
                    userRoot: this.userRoot,
                    run: async () => {},
                    task: async <T>(_: string, action: () => Promise<T> | T) => action(),
                    fail: (msg: string) => { throw new Error(msg); },
                } as any;

                await syncModules(updateContext, { force: true });
            }

            return;
        }

        if (commandName === '--upgrade') {
            const pkgPath = path.resolve(this.frameworkRoot, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const shell = this.container.get().shell;
            console.log(`Updating ${pkg.name}...`);
            // Deliberately `install -g <name>@latest`, NOT `npm update -g <name>`: `update` builds
            // an "ideal tree" from the registry manifest and diffs it against what's on disk,
            // removing whatever it can't reconcile — for a global CLI install that can degrade
            // into "removed N packages, added 0", leaving `tyr` present but non-functional with an
            // empty dependency tree. `install -g <name>@latest` always does a full, self-contained
            // reinstall instead, so it can't strand the install in that half-updated state.
            await shell.exec(`npm install -g ${pkg.name}@latest`);
            // Re-read package.json: the in-memory `pkg` above is what was on disk BEFORE the
            // upgrade, so `pkg.version` would still report the old version even after a
            // successful upgrade.
            const updatedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            console.log(`Current version:`, `tyr v${updatedPkg.version}`)
            return;
        }

        if (commandName === '--help' || commandName === '-h') {
            const helpContext = {
                ...this.container.get(),
                frameworkRoot: this.frameworkRoot,
                userRoot: this.userRoot,
                run: async () => {},
                task: async <T>(_: string, action: () => Promise<T> | T) => action(),
                fail: (msg: string) => { throw new Error(msg); },
            } as any;
            await help(helpContext)(args.slice(1));
            return;
        }

        const runInternal = async (cmd: string, cmdArgs: string[] = []) => {
            await this.handle([cmd, ...cmdArgs]);
        };

        const task = async <T>(description: string, action: () => Promise<T> | T, next: boolean = false, onFail?: () => void): Promise<T | undefined> => {
            try {
                return await action();
            } catch (e) {
                if (onFail) onFail();
                if (!next) {
                    throw new TyrError(
                        `Task failed: "${description}"`,
                        e,
                        'Check the previous logs or the configuration.'
                    );
                }
            }
        };

        const context: TyrContext = {
            ...this.container.get(),
            frameworkRoot: this.frameworkRoot,
            userRoot: this.userRoot,
            run: runInternal,
            task,
            fail: (msg: string, suggestion?: string) => { throw new TyrError(msg, null, suggestion, commandName); }
        };

        if (commandName === '--config') {
            await config(context)(args.slice(1));
            return;
        }

        if (commandName === '--modules') {
            await modulesCommand(context)(args.slice(1));
            return;
        }

        if (commandName === '--add') {
            await modulesCommand(context)(['add', ...args.slice(1)]);
            return;
        }

        if (commandName === '--del') {
            await modulesCommand(context)(['del', ...args.slice(1)]);
            return;
        }

        if (commandName === '--manifest') {
            await modulesCommand(context)(['manifest']);
            return;
        }

        const systemCommands: Record<string, CommandFactory> = {
            gen,
            rem,
            doc,
            chat,
        };

        if (systemCommands[commandName]) {
            await systemCommands[commandName](context)(args.slice(1));
            return;
        }

        if (!this.config) {
            throw new Error('Kernel has not been initialized (run boot first).');
        }

        let scriptPath = this.config.commands[commandName];

        if (!scriptPath && this.config.aliases?.[commandName]) {
            const aliasTarget = this.config.aliases[commandName];
            scriptPath = this.config.commands[aliasTarget];
        }

        if (!scriptPath) {
            context.logger?.error(`Command '${commandName}' not found.`);
            return;
        }

        try {
            const absolutePath = path.isAbsolute(scriptPath)
                ? scriptPath
                : path.resolve(this.frameworkRoot, scriptPath);

            const moduleUrl = pathToFileURL(absolutePath).href;
            const module = await import(moduleUrl);

            if (typeof module.default !== 'function') {
                throw new Error(`File ${scriptPath} does not export a default function.`);
            }

            const commandFactory: CommandFactory = module.default;
            const command = commandFactory(context);

            await command(args.slice(1));

        } catch (error: any) {
            this.handleError(error, args);
        }
    }

    /**
     * Normalises any error thrown while running a user command into a {@link TyrError} (tagging
     * it with the command name if it wasn't already), prints it via `TyrError.handle()`, and exits
     * the process with code 1. Only reached for commands resolved from `map.yml` — the hardcoded
     * flags and built-in system commands above are expected to handle their own errors (e.g. via
     * `context.fail()`, which already produces a `TyrError`).
     */
    private handleError(error: unknown, args: string[]): void {
        const logger = this.container.get().logger;
        const commandName = args[0];

        if (error instanceof TyrError) {
            const enriched = error.commandName
                ? error
                : new TyrError(error.message, error.originalError, error.suggestion, commandName);
            enriched.handle(this.isDebug, logger);
        } else {
            (new TyrError('Unhandled critical error', error, undefined, commandName)).handle(this.isDebug, logger);
        }

        process.exit(1);
    }
}
