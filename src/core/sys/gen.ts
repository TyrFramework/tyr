/**
 * @fileoverview Built-in `tyr gen <command-name> <file-name>` command.
 *
 * This file is a good first read for anyone writing their own Tyr command: it follows the exact
 * shape every command must have (default export = `(context: TyrContext) => (args: string[]) =>
 * Promise<void>`, see Kernel.ts's `CommandFactory` type), destructures only the pieces of
 * TyrContext it actually needs, and uses `logger`/`fs` instead of `console.log`/raw `node:fs`.
 *
 * What it does: scaffolds a new command file from a template under `~/.tyr/commands/`, then
 * registers it in `~/.tyr/map.yml` so the Kernel can find it on the next `tyr <command-name>` run
 * (see Kernel.handle()'s final `map.yml` lookup). `rem.ts` is the exact inverse of this file — read
 * them side by side.
 */
import path from 'path';
import yaml from 'js-yaml';
import type { TyrContext } from '../Kernel';

// Mirrors the shape Kernel.ts loads `~/.tyr/map.yml` into. Duplicated here (rather than imported
// from Kernel.ts) because this is a local, on-disk read/modify/write of that same file — see
// rem.ts and modules.ts, which each keep their own copy for the same reason.
interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

// The boilerplate written into every new command file. Note it imports `TyrContext` from
// '@orxataguy/tyr' (the published package), NOT a relative path — this file is generated INTO the
// user's own `~/.tyr/commands/` directory, outside this repository, so it must resolve the type
// through the npm package's public export (see src/index.ts) rather than a path that only makes
// sense inside this repo.
const template = `import type { TyrContext } from '@orxataguy/tyr';

export default ({ run, task, fail, logger, shell, fs }: TyrContext) => {
    return async (args: string[]) => {
        logger.info("Running command: %s");

        // Your logic here...
        // Run "tyr doc" to see the documentation for available managers

        logger.success("Command %s finished!");
    };
};

export const Test = { args: [] };
`;

/**
 * @method gen (default export)
 * @description Scaffolds `~/.tyr/commands/<file-name>.tyr.ts` from the template above (with the
 * command name substituted into its log messages) and registers `<command-name>` in
 * `~/.tyr/map.yml`, pointing it at the new file. Refuses to overwrite an existing file, but WILL
 * overwrite an existing `map.yml` entry with the same command name (with a warning) — useful if a
 * user re-runs `tyr gen` after manually renaming/moving the generated file.
 * @param {TyrContext} context - Only `logger`, `fs` and `userRoot` are needed here.
 * @returns {(args: string[]) => Promise<void>} Handler expecting `args = [commandName, fileName]`.
 * @example
 * // tyr gen greet greet
 * // -> writes ~/.tyr/commands/greet.tyr.ts
 * // -> adds `greet: ./commands/greet.tyr.ts` to ~/.tyr/map.yml
 */
export default function gen({ logger, fs, userRoot }: TyrContext) {
    return async (args: string[]) => {
        const commandName = args[0];
        const fileName = args[1];

        // Both positional args are required — bail out early with usage help rather than letting
        // downstream code fail on an undefined path.
        if (!commandName || !fileName) {
            logger.error('Incorrect usage.');
            logger.info('Syntax: tyr gen [command-name] [file-name]');
            return;
        }

        logger.info(`Creating new command: '${commandName}' -> '${fileName}.tyr.ts'`);

        // Command files always live under ~/.tyr/commands/, named `<file-name>.tyr.ts` by
        // convention (the `.tyr.ts` suffix is what `tyr doc`/`tyr help` scan for, and lets these
        // files be told apart from any other TypeScript a user keeps in the same directory).
        const commandsDir = path.join(userRoot, 'commands');
        const filePath = path.join(commandsDir, `${fileName}.tyr.ts`);

        // Never clobber an existing command file — a user may have already written real logic
        // into it. Re-running `tyr gen` with the same file-name is a no-op error, not a reset.
        if (fs.exists(filePath)) {
            logger.error(`File ${fileName}.tyr.ts already exists. Aborting.`);
            return;
        }

        // Fill in the two "%s" placeholders in the template with the command name, then write the
        // file (fs.write() — see FileSystemManager — also creates ~/.tyr/commands/ if missing and
        // takes a .bak backup of anything it overwrites, though that can't happen here since we
        // just checked the file doesn't exist).
        const templateFilled = template.replaceAll('%s', commandName);
        await fs.write(filePath, templateFilled.trim());

        // Second step: register the command in ~/.tyr/map.yml so the Kernel can resolve
        // `tyr <command-name>` to this file. Read-modify-write rather than append, since map.yml
        // is a single YAML document the Kernel parses as a whole.
        const mapPath = path.join(userRoot, 'map.yml');
        try {
            const currentConfigRaw = await fs.read(mapPath);
            // Falls back to an empty `{ commands: {} }` config if map.yml doesn't exist yet (e.g.
            // it was deleted by hand) or is empty, so `tyr gen` still works without requiring
            // `tyr --config` to have been run first.
            const config = (yaml.load(currentConfigRaw ?? 'commands: {}') ?? { commands: {} }) as TyrConfig;

            if (!config.commands) config.commands = {};

            // Overwriting an existing entry is allowed (unlike the file-exists check above) —
            // this only warns, since re-pointing a command name at a newly generated file is a
            // reasonable thing to want.
            if (config.commands[commandName]) {
                logger.warn(`Command '${commandName}' already existed. Updating path...`);
            }

            // Stored as a path relative to userRoot (`./commands/...`), matching how Kernel.ts
            // resolves non-absolute map.yml paths — keeps map.yml portable if ~/.tyr itself is
            // moved or synced to a different machine via a linked git repo (see sys/config.ts).
            config.commands[commandName] = `./commands/${fileName}.tyr.ts`;

            const newYaml = yaml.dump(config, { indent: 2, lineWidth: -1 });
            await fs.write(mapPath, newYaml);

            logger.success(`Command '${commandName}' created at ${filePath}`);
            logger.success(`Registered in ${mapPath}`);
        } catch (e) {
            // The command FILE was already written successfully above at this point — only the
            // map.yml registration failed. Reported as a distinct, non-fatal error (not re-thrown)
            // so the user knows to manually add the entry rather than assuming nothing happened.
            logger.error('Error updating configuration.');
            console.error(e);
        }
    };
}
