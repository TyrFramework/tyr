/**
 * @fileoverview Built-in `tyr rem <command-name>` command — the exact inverse of `gen.ts`.
 *
 * Same command shape as `gen.ts` (default export = `(context) => (args) => Promise<void>`); read
 * that file's header first if you haven't. This one deletes a hand-generated command's file and
 * removes it (plus any alias pointing at it) from `~/.tyr/map.yml`.
 *
 * Note this only handles commands the user (or `tyr gen`) registered directly. Commands installed
 * via `tyr --add <manifest-url>` are tracked separately in `~/.tyr/imported_modules.lock.yml` and
 * are removed with `tyr --del <module-name>` instead (see `sys/modules.ts`'s `removeModule()`),
 * which also knows how to clean up module-owned `.env.*.example` files that `rem` does not touch.
 */
import path from 'path';
import yaml from 'js-yaml';
import type { TyrContext } from '../Kernel';

// Same shape Kernel.ts and gen.ts use for ~/.tyr/map.yml — kept as a local copy for the same
// reason gen.ts does (this is a standalone read/modify/write of that file).
interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

/**
 * @method rem (default export)
 * @description Deletes the `.tyr.ts` file a command name points to and removes it — along with any
 * alias that targets it — from `~/.tyr/map.yml`. Unlike `gen`'s file-exists guard, this only
 * checks that the command is *registered*; if the file itself was already deleted by hand,
 * `fs.delete()` will throw and that's surfaced via the catch block below rather than silently
 * treated as success.
 * @param {TyrContext} context - Only `logger`, `fs` and `userRoot` are needed here.
 * @returns {(args: string[]) => Promise<void>} Handler expecting `args = [commandName]`.
 * @example
 * // tyr rem greet
 * // -> deletes ~/.tyr/commands/greet.tyr.ts
 * // -> removes the `greet` entry (and any alias pointing to it) from ~/.tyr/map.yml
 */
export default function rem({ logger, fs, userRoot }: TyrContext) {
    return async (args: string[]) => {
        const commandName = args[0];

        if (!commandName) {
            logger.error('Missing command name to remove.');
            return;
        }

        logger.info(`Starting removal of command: '${commandName}'`);

        const mapPath = path.join(userRoot, 'map.yml');

        try {
            const currentConfigRaw = await fs.read(mapPath);
            // Unlike gen.ts, a missing map.yml is treated as a hard error here rather than a
            // fallback to an empty config — there's nothing meaningful to "remove" from a
            // nonexistent registry, and this points the user at the real fix (`tyr --config`).
            if (!currentConfigRaw) {
                logger.error(`${mapPath} not found. Run 'tyr --config' first.`);
                return;
            }

            const config = yaml.load(currentConfigRaw) as TyrConfig;

            // Refuse to touch anything if the command isn't actually registered — avoids a
            // confusing partial no-op (e.g. silently "succeeding" at removing nothing).
            if (!config.commands?.[commandName]) {
                logger.error(`Command '${commandName}' does not exist in ~/.tyr/map.yml.`);
                return;
            }

            // map.yml stores paths relative to userRoot (see gen.ts) — resolve back to an
            // absolute path before deleting the actual file on disk.
            const relativeScriptPath = config.commands[commandName];
            const absoluteScriptPath = path.resolve(userRoot, relativeScriptPath);

            await fs.delete(absoluteScriptPath);
            delete config.commands[commandName];

            // Clean up dangling aliases: an alias that used to resolve through this command name
            // would otherwise silently point at nothing (Kernel.handle()'s alias lookup falls
            // through to `config.commands[aliasTarget]`, which would now be undefined).
            if (config.aliases) {
                for (const [alias, target] of Object.entries(config.aliases)) {
                    if (target === commandName) {
                        delete config.aliases[alias];
                        logger.info(`Alias '${alias}' removed.`);
                    }
                }
            }

            const newYaml = yaml.dump(config, { indent: 2, lineWidth: -1 });
            await fs.write(mapPath, newYaml);

            logger.success(`Command '${commandName}' removed.`);
        } catch (e) {
            // Covers both a failed fs.delete() (e.g. the file was already missing) and a failed
            // map.yml rewrite — either way the state may now be partially updated, so this is
            // reported as a "critical" error rather than a soft warning.
            logger.error('Critical error during removal.');
            console.error(e);
        }
    };
}
