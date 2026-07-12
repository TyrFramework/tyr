/**
 * @fileoverview Built-in `tyr --modules`/`--add`/`--del`/`--manifest` commands — the "package
 * manager" layer on top of `map.yml`. Where `gen.ts`/`rem.ts` manage commands a user writes by
 * hand, this file manages commands imported from someone else's `manifest.json` (a flat map of
 * command name -> raw file URL, published via `generateManifest()` below) and keeps track of which
 * command file "belongs to" which imported module in `~/.tyr/imported_modules.lock.yml`, so a sync
 * never overwrites something it doesn't own and `tyr --del` can cleanly uninstall exactly what it
 * installed. `Kernel.handle()` calls into this file directly for `--modules`/`--add`/`--del`/
 * `--manifest` (see its dedicated `if` branches) rather than through the `systemCommands` table
 * `gen`/`rem`/`doc`/`chat` go through.
 *
 * Three files this module owns, all under `~/.tyr/`:
 *   - `imported_modules.yaml`  — module name -> manifest URL (what's registered).
 *   - `imported_modules.lock.yml` — command/env-file name -> which module + manifest + source URL
 *     installed it (what's actually on disk and why).
 *   - `map.yml` — shared with `gen.ts`/`rem.ts`; imported commands are added here exactly like
 *     hand-written ones, so the Kernel doesn't need to know the difference at resolution time.
 */
import path from 'path';
import yaml from 'js-yaml';
import type { TyrContext } from '../Kernel';
import { TyrError } from '../TyrError';

interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

interface ImportedModulesFile {
    modules: Record<string, string>;
}

interface ManagedCommand {
    module: string;
    manifest: string;
    source: string;
}

interface ManagedEnvFile {
    manifest: string;
    source: string;
    file: string;
}

interface ModulesLock {
    commands: Record<string, ManagedCommand>;
    env?: Record<string, ManagedEnvFile>;
}

export interface SyncSummary {
    installed: string[];
    updated: string[];
    skipped: string[];
    failed: { command: string; reason: string }[];
}

const IMPORTED_MODULES_FILE = 'imported_modules.yaml';
const LOCK_FILE = 'imported_modules.lock.yml';

function isValidHttpsUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:';
    } catch {
        return false;
    }
}

// Allows namespaced command names like 'db:migrate', but not a leading/
// trailing/doubled ':' (e.g. ':foo', 'foo:', 'a::b'), since those would
// produce an empty segment.
function isValidCommandName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)*$/.test(name);
}

// ':' is a valid character in a command name (namespacing, e.g. 'db:migrate')
// but isn't a safe filename component on every platform (Windows reserves it).
// Only used when deriving the on-disk file name — the real name with its
// colons is still what's stored in map.yml, the lockfile, and the manifest.
function toSafeFilename(commandName: string): string {
    return commandName.replace(/:/g, '-');
}

function sanitizeSlug(value: string): string {
    const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'module';
}

/**
 * Default module name when `tyr --add <url>` is called without one.
 * For a raw.githubusercontent.com URL (the expected shape:
 * raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>) this uses the
 * repository name, since that's what identifies where the module comes from.
 * For any other host — a manifest can be served from anywhere, as long as
 * it's https — falls back to a slug of the manifest file's own name.
 */
function defaultModuleNameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);

        if (parsed.hostname === 'raw.githubusercontent.com' && segments.length >= 2) {
            return sanitizeSlug(segments[1]);
        }

        const base = segments.pop() ?? 'module';
        const withoutExt = base.replace(/\.json$/i, '').replace(/\.manifest$/i, '');
        return sanitizeSlug(withoutExt);
    } catch {
        return 'module';
    }
}

async function loadYaml<T>(fs: any, filePath: string, fallback: T): Promise<T> {
    const raw = await fs.read(filePath);
    if (!raw) return fallback;
    try {
        return (yaml.load(raw) as T) ?? fallback;
    } catch {
        return fallback;
    }
}

async function saveYaml(fs: any, filePath: string, data: unknown): Promise<void> {
    await fs.write(filePath, yaml.dump(data, { indent: 2, lineWidth: -1 }));
}

// Reserved manifest key for an optional .env.example reference. '$' can never
// appear in a valid command name (see isValidCommandName), so it can't collide
// with a real command.
const ENV_MANIFEST_KEY = '$env';

interface ParsedManifest {
    commands: Record<string, string>;
    envUrl?: string;
}

/**
 * Fetches a manifest.json (name -> raw file URL) and validates its shape.
 * Only https URLs and safe command names are accepted, to avoid path
 * traversal and to keep imported code coming from a known-good transport.
 * A manifest may also carry a reserved `$env` key pointing at a raw
 * .env.example file for the module's required environment variables.
 */
async function fetchManifest(web: any, manifestUrl: string): Promise<ParsedManifest> {
    if (!isValidHttpsUrl(manifestUrl)) {
        throw new TyrError(`Manifest URL must use https: ${manifestUrl}`);
    }

    const raw = await web.get(manifestUrl);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TyrError(`Manifest at ${manifestUrl} is not a valid JSON object.`);
    }

    const commands: Record<string, string> = {};
    let envUrl: string | undefined;

    for (const [name, value] of Object.entries(parsed)) {
        if (name === ENV_MANIFEST_KEY) {
            if (typeof value !== 'string' || !isValidHttpsUrl(value)) {
                throw new TyrError(`Manifest at ${manifestUrl} has an invalid (non-https) URL for '${ENV_MANIFEST_KEY}'.`);
            }
            envUrl = value;
            continue;
        }

        if (!isValidCommandName(name)) {
            throw new TyrError(`Manifest at ${manifestUrl} has an invalid command name: '${name}'`);
        }
        if (typeof value !== 'string' || !isValidHttpsUrl(value)) {
            throw new TyrError(`Manifest at ${manifestUrl} has an invalid (non-https) URL for command '${name}'.`);
        }
        commands[name] = value;
    }

    return { commands, envUrl };
}

/**
 * Reconciles ~/.tyr/imported_modules.yaml against ~/.tyr/map.yml.
 *
 * - A command that doesn't exist yet in map.yml is installed.
 * - A command that already exists and isn't tracked in the lockfile is left
 *   untouched (it predates the import, or was hand-written).
 * - A command tracked in the lockfile is only re-downloaded when `force` is
 *   set (used by `tyr --update`), so day-to-day syncs never clobber content
 *   silently.
 * - If two modules define the same command name, the last one processed
 *   wins (modules are processed in the order they appear in
 *   imported_modules.yaml).
 */
export async function syncModules(context: TyrContext, options: { force?: boolean } = {}): Promise<SyncSummary> {
    const { logger, fs, web, userRoot } = context as any;
    const force = options.force ?? false;

    const summary: SyncSummary = { installed: [], updated: [], skipped: [], failed: [] };

    const modulesPath = path.join(userRoot, IMPORTED_MODULES_FILE);
    const mapPath = path.join(userRoot, 'map.yml');
    const lockPath = path.join(userRoot, LOCK_FILE);

    if (!fs.exists(modulesPath)) {
        logger.info(`No ${IMPORTED_MODULES_FILE} found. Nothing to sync.`);
        return summary;
    }

    const modulesFile = await loadYaml<ImportedModulesFile>(fs, modulesPath, { modules: {} });
    const mapConfig = await loadYaml<TyrConfig>(fs, mapPath, { commands: {} });
    const lock = await loadYaml<ModulesLock>(fs, lockPath, { commands: {} });

    if (!mapConfig.commands) mapConfig.commands = {};
    if (!lock.commands) lock.commands = {};
    if (!lock.env) lock.env = {};

    // Snapshot the state as it was *before* this run. Collisions between two
    // modules processed in the same run are resolved by processing order
    // (last one wins), independently of the --force flag; only commands that
    // already existed prior to this run are subject to the install/skip/
    // force-update rules below.
    const mapSnapshot = { ...mapConfig.commands };
    const lockSnapshot = { ...lock.commands };

    let mapChanged = false;
    let lockChanged = false;

    for (const [moduleName, manifestUrl] of Object.entries(modulesFile.modules ?? {})) {
        logger.info(`Syncing module '${moduleName}' (${manifestUrl})...`);

        let parsedManifest: ParsedManifest;
        try {
            parsedManifest = await fetchManifest(web, manifestUrl);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            logger.error(`Could not read manifest for module '${moduleName}': ${reason}`);
            // logger.error() is silenced unless --debug is passed, so mirror it via
            // logger.info() too — otherwise this failure would be entirely invisible.
            logger.info(`Skipped module '${moduleName}': ${reason}`);
            summary.failed.push({ command: moduleName, reason });
            continue;
        }

        const { commands: manifest, envUrl } = parsedManifest;

        for (const [commandName, fileUrl] of Object.entries(manifest)) {
            const alreadyInMap = !!mapSnapshot[commandName];
            const managed = lockSnapshot[commandName];

            const shouldInstall = !alreadyInMap;
            const shouldForceUpdate = force && !!managed;

            if (!shouldInstall && !shouldForceUpdate) {
                if (alreadyInMap && !managed) {
                    logger.info(`Skipping '${commandName}': already exists and is not managed by an import.`);
                } else {
                    logger.info(`Skipping '${commandName}': already installed. Use 'tyr --update' to refresh.`);
                }
                summary.skipped.push(commandName);
                continue;
            }

            try {
                const content = await web.get(fileUrl);
                const fileContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

                const fileName = toSafeFilename(commandName);
                const destPath = path.join(userRoot, 'commands', `${fileName}.tyr.ts`);
                await fs.write(destPath, fileContent);

                if (managed && managed.module !== moduleName) {
                    logger.warn(`'${commandName}' was previously managed by module '${managed.module}'; now owned by '${moduleName}'.`);
                }

                mapConfig.commands[commandName] = `./commands/${fileName}.tyr.ts`;
                lock.commands[commandName] = { module: moduleName, manifest: manifestUrl, source: fileUrl };
                mapChanged = true;
                lockChanged = true;

                if (shouldInstall) {
                    logger.success(`Installed '${commandName}' from module '${moduleName}'.`);
                    summary.installed.push(commandName);
                } else {
                    logger.success(`Updated '${commandName}' from module '${moduleName}'.`);
                    summary.updated.push(commandName);
                }
            } catch (e) {
                const reason = e instanceof Error ? e.message : String(e);
                logger.error(`Could not download '${commandName}' from '${fileUrl}': ${reason}`);
                logger.info(`Skipped '${commandName}': ${reason}`);
                summary.failed.push({ command: commandName, reason });
            }
        }

        if (envUrl) {
            const envFileName = `.env.${toSafeFilename(moduleName)}.example`;
            const envDestPath = path.join(userRoot, envFileName);
            const envManaged = lock.env![moduleName];

            const shouldInstallEnv = !fs.exists(envDestPath);
            const shouldForceUpdateEnv = force && !!envManaged;

            if (!shouldInstallEnv && !shouldForceUpdateEnv) {
                logger.info(
                    envManaged
                        ? `Skipping ${envFileName}: already installed. Use 'tyr --update' to refresh.`
                        : `Skipping ${envFileName}: a file with that name already exists and isn't managed by an import.`
                );
            } else {
                try {
                    const envContent = await web.get(envUrl);
                    const envFileContent = typeof envContent === 'string' ? envContent : JSON.stringify(envContent, null, 2);
                    await fs.write(envDestPath, envFileContent);

                    lock.env![moduleName] = { manifest: manifestUrl, source: envUrl, file: envFileName };
                    lockChanged = true;

                    logger.success(`${shouldInstallEnv ? 'Installed' : 'Updated'} ${envFileName} from module '${moduleName}'.`);
                } catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    logger.error(`Could not download ${envFileName} for module '${moduleName}': ${reason}`);
                    logger.info(`Could not download ${envFileName} for module '${moduleName}': ${reason}`);
                    summary.failed.push({ command: envFileName, reason });
                }
            }
        }
    }

    if (mapChanged) await saveYaml(fs, mapPath, mapConfig);
    if (lockChanged) await saveYaml(fs, lockPath, lock);

    logger.info(
        `Sync finished — installed: ${summary.installed.length}, updated: ${summary.updated.length}, ` +
        `skipped: ${summary.skipped.length}, failed: ${summary.failed.length}.`
    );

    if (summary.failed.length > 0) {
        logger.info('Failures:');
        for (const { command, reason } of summary.failed) {
            logger.info(`  - ${command}: ${reason}`);
        }
    }

    return summary;
}

/**
 * Registers a manifest URL under a module name in imported_modules.yaml and
 * immediately syncs it (downloads whatever commands are missing).
 */
export async function addModule(context: TyrContext, manifestUrl: string, name?: string): Promise<void> {
    const { logger, fs, web, userRoot } = context as any;

    if (!manifestUrl) {
        logger.error('Missing manifest URL.');
        logger.info('Usage: tyr --add <manifest-url> [name]');
        return;
    }

    if (!isValidHttpsUrl(manifestUrl)) {
        logger.error('Manifest URL must be a valid https:// URL.');
        logger.info(`Could not add module: '${manifestUrl}' is not a valid https:// URL.`);
        return;
    }

    logger.info(`Validating manifest: ${manifestUrl}`);
    try {
        await fetchManifest(web, manifestUrl);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error(`Could not add module: ${reason}`);
        logger.info(`Could not add module: ${reason}`);
        return;
    }

    const moduleName = name && isValidCommandName(name) ? name : defaultModuleNameFromUrl(manifestUrl);

    const modulesPath = path.join(userRoot, IMPORTED_MODULES_FILE);
    const modulesFile = await loadYaml<ImportedModulesFile>(fs, modulesPath, { modules: {} });
    if (!modulesFile.modules) modulesFile.modules = {};

    if (modulesFile.modules[moduleName] && modulesFile.modules[moduleName] !== manifestUrl) {
        logger.warn(`Module '${moduleName}' already pointed to a different manifest. Overwriting.`);
    }

    modulesFile.modules[moduleName] = manifestUrl;
    await saveYaml(fs, modulesPath, modulesFile);
    logger.success(`Module '${moduleName}' registered in ${modulesPath}`);

    await syncModules(context);
}

/**
 * Unregisters a module: removes it from imported_modules.yaml, deletes every
 * command file it's tracked as owning in the lockfile, drops those commands
 * (and any aliases pointing at them) from map.yml, deletes its
 * `.env.<module>.example` if one was imported, and clears their lockfile
 * entries. The counterpart to `tyr --add` — closes the loop.
 */
export async function removeModule(context: TyrContext, moduleName: string): Promise<void> {
    const { logger, fs, userRoot } = context as any;

    if (!moduleName) {
        logger.error('Missing module name.');
        logger.info('Usage: tyr --del <module-name>');
        return;
    }

    const modulesPath = path.join(userRoot, IMPORTED_MODULES_FILE);
    const mapPath = path.join(userRoot, 'map.yml');
    const lockPath = path.join(userRoot, LOCK_FILE);

    const modulesFile = await loadYaml<ImportedModulesFile>(fs, modulesPath, { modules: {} });
    const mapConfig = await loadYaml<TyrConfig>(fs, mapPath, { commands: {} });
    const lock = await loadYaml<ModulesLock>(fs, lockPath, { commands: {} });

    if (!modulesFile.modules) modulesFile.modules = {};
    if (!mapConfig.commands) mapConfig.commands = {};
    if (!lock.commands) lock.commands = {};
    if (!lock.env) lock.env = {};

    const isRegistered = !!modulesFile.modules[moduleName];
    const managedCommands = Object.entries(lock.commands)
        .filter(([, info]) => info.module === moduleName)
        .map(([commandName]) => commandName);
    const managedEnv = lock.env[moduleName];

    if (!isRegistered && managedCommands.length === 0 && !managedEnv) {
        logger.error(`Module '${moduleName}' is not registered and owns no commands. Nothing to remove.`);
        logger.info(`Module '${moduleName}' was not found in ${IMPORTED_MODULES_FILE} or ${LOCK_FILE}.`);
        return;
    }

    let mapChanged = false;
    let lockChanged = false;

    for (const commandName of managedCommands) {
        const scriptPath = mapConfig.commands[commandName];
        if (scriptPath) {
            const absolutePath = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(userRoot, scriptPath);
            if (fs.exists(absolutePath)) {
                await fs.delete(absolutePath);
            }
            delete mapConfig.commands[commandName];
            mapChanged = true;
        }

        if (mapConfig.aliases) {
            for (const [alias, target] of Object.entries(mapConfig.aliases)) {
                if (target === commandName) {
                    delete mapConfig.aliases[alias];
                    mapChanged = true;
                    logger.info(`Alias '${alias}' removed (pointed to '${commandName}').`);
                }
            }
        }

        delete lock.commands[commandName];
        lockChanged = true;

        logger.success(`Removed command '${commandName}' (was managed by module '${moduleName}').`);
    }

    if (managedEnv) {
        const envPath = path.join(userRoot, managedEnv.file);
        if (fs.exists(envPath)) {
            await fs.delete(envPath);
        }
        delete lock.env[moduleName];
        lockChanged = true;
        logger.success(`Removed ${managedEnv.file} (was managed by module '${moduleName}').`);
    }

    if (isRegistered) {
        delete modulesFile.modules[moduleName];
        await saveYaml(fs, modulesPath, modulesFile);
    }

    if (mapChanged) await saveYaml(fs, mapPath, mapConfig);
    if (lockChanged) await saveYaml(fs, lockPath, lock);

    const removedItems = [...managedCommands, ...(managedEnv ? [managedEnv.file] : [])];
    const removedList = removedItems.length ? `: ${removedItems.join(', ')}` : '';
    logger.success(
        `Module '${moduleName}' removed` +
        (removedItems.length ? ` — ${removedItems.length} item(s) removed${removedList}.` : ' (it had nothing managed).')
    );
    logger.info(`Module '${moduleName}' unlinked from ${IMPORTED_MODULES_FILE}${removedList}.`);
}

interface GithubRepoInfo {
    owner: string;
    repo: string;
}

/**
 * Parses the owner/repo out of a GitHub remote URL. Only github.com is
 * supported, since manifest.json entries are meant to resolve through
 * raw.githubusercontent.com.
 */
function parseGithubRemote(remoteUrl: string): GithubRepoInfo | null {
    const patterns = [
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/,
        /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/,
        /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(\.git)?$/,
    ];

    for (const pattern of patterns) {
        const match = remoteUrl.trim().match(pattern);
        if (match) return { owner: match[1], repo: match[2] };
    }

    return null;
}

/**
 * Generates ~/.tyr/manifest.json from the commands currently registered in
 * map.yml, pointing each one at its raw.githubusercontent.com URL. This is
 * the publishing counterpart of `tyr --add`: whatever this produces can be
 * handed to someone else, who registers it with `tyr --add <url>`.
 *
 * If ~/.tyr/.env.example exists, its raw URL is also included under the
 * reserved `$env` key, so `tyr --add` downloads it as `.env.<module>.example`
 * for whoever installs this manifest.
 *
 * Requires ~/.tyr to be a git repository linked to a GitHub remote — there's
 * no way to build a raw.githubusercontent.com URL otherwise.
 */
export async function generateManifest(context: TyrContext): Promise<void> {
    const { logger, fs, shell, userRoot } = context as any;

    const gitDir = path.join(userRoot, '.git');
    if (!fs.exists(gitDir)) {
        logger.error('~/.tyr has no linked git repository. Cannot generate manifest.json.');
        logger.info('Link one first: tyr --config --repo <url>');
        return;
    }

    shell.cd(userRoot);

    let remoteUrl: string;
    try {
        remoteUrl = await shell.exec('git remote get-url origin');
    } catch {
        logger.error("~/.tyr's repository has no 'origin' remote configured. Cannot generate manifest.json.");
        logger.info("Cannot generate manifest.json: ~/.tyr's repository has no 'origin' remote configured.");
        return;
    }

    const repoInfo = parseGithubRemote(remoteUrl);
    if (!repoInfo) {
        logger.error(`Cannot generate manifest.json: only GitHub repositories are supported (raw.githubusercontent.com). Remote was: ${remoteUrl}`);
        logger.info(`Cannot generate manifest.json: only GitHub repositories are supported. Remote was: ${remoteUrl}`);
        return;
    }

    let branch = 'main';
    try {
        const currentBranch = await shell.exec('git rev-parse --abbrev-ref HEAD');
        if (currentBranch && currentBranch !== 'HEAD') {
            branch = currentBranch;
        } else {
            logger.info(`Could not determine the current branch (detached HEAD?). Falling back to '${branch}'.`);
        }
    } catch {
        logger.info(`Could not determine the current branch. Falling back to '${branch}'.`);
    }

    const mapPath = path.join(userRoot, 'map.yml');
    const mapConfig = await loadYaml<TyrConfig>(fs, mapPath, { commands: {} });
    const commands = mapConfig.commands ?? {};

    const manifest: Record<string, string> = {};
    const skipped: string[] = [];

    for (const [name, scriptPath] of Object.entries(commands)) {
        const repoRelativePath = path.isAbsolute(scriptPath)
            ? path.relative(userRoot, scriptPath)
            : scriptPath.replace(/^\.[/\\]/, '');

        if (repoRelativePath.startsWith('..')) {
            logger.info(`Skipping '${name}': its file lives outside ~/.tyr and can't be published.`);
            skipped.push(name);
            continue;
        }

        const normalized = repoRelativePath.split(path.sep).join('/');
        manifest[name] = `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${branch}/${normalized}`;
    }

    const commandCount = Object.keys(manifest).length;
    if (commandCount === 0) {
        logger.info('No commands to include in manifest.json.');
    }

    // If ~/.tyr has a .env.example, publish it too — tyr --add downloads it as
    // .env.<module>.example so whoever installs this manifest knows which
    // environment variables these commands expect.
    const envExamplePath = path.join(userRoot, '.env.example');
    let includedEnv = false;
    if (fs.exists(envExamplePath)) {
        manifest[ENV_MANIFEST_KEY] = `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${branch}/.env.example`;
        includedEnv = true;
    }

    const manifestPath = path.join(userRoot, 'manifest.json');
    await fs.write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    logger.success(
        `manifest.json generated at ${manifestPath} (${commandCount} commands` +
        `${skipped.length ? `, ${skipped.length} skipped` : ''}` +
        `${includedEnv ? ', includes .env.example' : ''}).`
    );
    logger.info("Commit and push it so others can install it with: tyr --add <raw-url-to-manifest.json>");
}

/**
 * @method modules (default export)
 * @description Subcommand dispatcher for `tyr --modules [sync|list|manifest|del <name>]`.
 * `Kernel.handle()`'s `--add`/`--del`/`--manifest` flags are themselves implemented as calls into
 * this same dispatcher with a synthesized `sub` (see Kernel.ts's `--add`/`--del`/`--manifest`
 * branches) — this function is the single entry point all module-management flags funnel through.
 * @param {TyrContext} context - Passed through to whichever subcommand handles the call.
 * @returns {(args: string[]) => Promise<void>} Handler expecting `args = [subcommand, ...rest]`.
 * @example
 * // tyr --modules          (sub = undefined -> same as 'list')
 * // tyr --modules sync --force
 */
export default function modules(context: TyrContext) {
    return async (args: string[]) => {
        const { logger, fs, userRoot } = context as any;
        const sub = args[0];

        switch (sub) {
            case 'sync': {
                await syncModules(context, { force: args.includes('--force') });
                return;
            }
            case 'add': {
                await addModule(context, args[1], args[2]);
                return;
            }
            case 'del': {
                await removeModule(context, args[1]);
                return;
            }
            case 'manifest': {
                await generateManifest(context);
                return;
            }
            case 'list':
            case undefined: {
                const modulesPath = path.join(userRoot, IMPORTED_MODULES_FILE);
                const modulesFile = await loadYaml<ImportedModulesFile>(fs, modulesPath, { modules: {} });
                const entries = Object.entries(modulesFile.modules ?? {});

                if (entries.length === 0) {
                    logger.info('No imported modules registered.');
                    logger.info('Add one with: tyr --add <manifest-url> [name]');
                    return;
                }

                logger.info('Imported modules:');
                for (const [name, url] of entries) {
                    logger.info(`  ${name} -> ${url}`);
                }
                return;
            }
            default:
                logger.error(`Unknown subcommand '${sub}'.`);
                logger.info('Usage: tyr --modules [sync|list|manifest|del <module-name>]');
        }
    };
}
