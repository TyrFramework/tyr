/**
 * @fileoverview Built-in `tyr --help` command. Unlike the other `sys/*` commands, this is invoked
 * directly from `Kernel.handle()`'s `--help`/`-h` branch with a hand-built, minimal context (see
 * that branch's `helpContext`) rather than the full one — `help` only ever needs `userRoot`, so it
 * doesn't require the rest of the Container to be meaningfully usable.
 *
 * Prints two sections: the framework's own built-in commands (hardcoded in `builtins` below — kept
 * in sync with `Kernel.handle()` by hand, there is no single source of truth shared between the
 * two) and every user command found in `~/.tyr/commands/*.tyr.ts`, whose description/usage is
 * scraped from that file's own leading JSDoc-style comment (see `parseCommandDoc`).
 */
import fs from 'fs';
import path from 'path';
import { TyrContext } from '../Kernel';

interface CommandDoc {
    name: string;
    description: string;
    usage: string;
}

/**
 * Extracts a user command's description and usage from the first `/** ... *\/` block at the top
 * of its `.tyr.ts` file. The block is split on a line starting with `uso:` (Spanish for "usage:")
 * — everything before it is the description, everything after is the usage text. A file with no
 * leading comment, or no `uso:` line, still works (falls back to an empty usage / the whole
 * comment as description) rather than throwing.
 */
function parseCommandDoc(filePath: string): CommandDoc {
    const fileName = path.basename(filePath, '.tyr.ts');
    const content = fs.readFileSync(filePath, 'utf-8');

    const match = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (!match) {
        return { name: fileName, description: '', usage: '' };
    }

    const lines = match[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trimEnd());

    const usoIndex = lines.findIndex(l => /^uso:/i.test(l.trim()));

    let description = '';
    let usage = '';

    if (usoIndex !== -1) {
        description = lines
            .slice(0, usoIndex)
            .filter(l => l.trim() !== '')
            .join('\n')
            .trim();

        usage = lines
            .slice(usoIndex + 1)
            .filter(l => l.trim() !== '')
            .map(l => l.trim())
            .join('\n')
            .trim();
    } else {
        description = lines.filter(l => l.trim() !== '').join('\n').trim();
    }

    return { name: fileName, description, usage };
}

/**
 * @method help (default export)
 * @description Prints the framework's built-in commands and every user command found under
 * `~/.tyr/commands/`, formatted with raw ANSI escape codes (no external color library — unlike
 * the rest of the framework, which routes all output through `Logger`/chalk; this file writes
 * directly to `console.log` since it needs full control over a multi-column layout).
 * @param {TyrContext} context - Only `userRoot` is needed here.
 * @returns {(args: string[]) => Promise<void>} Handler (ignores `args`).
 * @example
 * // tyr --help
 */
export default function help({ userRoot }: TyrContext) {
    return async (_args: string[]) => {
        const commandsDir = path.join(userRoot, 'commands');

        // ── ANSI ──────────────────────────────────────────────────────────
        const reset  = '\x1b[0m';
        const bold   = '\x1b[1m';
        const dim    = '\x1b[2m';
        const cyan   = '\x1b[36m';
        const green  = '\x1b[32m';
        const yellow = '\x1b[33m';
        const gray   = '\x1b[90m';
        const white  = '\x1b[37m';
        // ──────────────────────────────────────────────────────────────────

        const separator = `${gray}  ${'─'.repeat(50)}${reset}`;

        console.log('');
        console.log(`  ${bold}${cyan}tyr${reset}  ${white}Available commands${reset}`);
        console.log(separator);
        console.log('');

        const builtins = [
            { name: '--help',    description: 'Shows this command listing.',                  usage: 'tyr --help' },
            { name: '--version', description: 'Shows the installed version of tyr.',          usage: 'tyr --version' },
            { name: '--config',  description: 'Configures tyr for the first time.',           usage: 'tyr --config' },
            { name: '--update',  description: 'Updates ~/.tyr from the git repository and refreshes imported modules.', usage: 'tyr --update' },
            { name: '--upgrade', description: 'Upgrades the tyr npm package.',                usage: 'tyr --upgrade' },
            { name: '--modules', description: 'Lists or syncs modules imported via manifest.json.', usage: 'tyr --modules [sync|list]' },
            { name: '--add',     description: 'Registers a manifest.json URL as an imported module and syncs it.', usage: 'tyr --add <manifest-url> [name]' },
            { name: '--del',     description: 'Unregisters an imported module and removes the commands it owns.', usage: 'tyr --del <module-name>' },
            { name: '--manifest', description: 'Generates ~/.tyr/manifest.json from your commands (needs a GitHub-linked repo).', usage: 'tyr --manifest' },
            { name: 'gen',       description: 'Generates a new command from a description using AI.', usage: 'tyr gen <name> "<description>"' },
            { name: 'doc',       description: 'Opens the framework documentation in the browser.', usage: 'tyr doc' },
            { name: 'chat',      description: 'Opens an AI chat + file browser for a directory.',  usage: 'tyr chat [directory] [--port <n>] [--split <0-1>]' },
        ];

        console.log(`  ${bold}${yellow}Framework${reset}`);
        console.log('');

        for (const cmd of builtins) {
            console.log(`  ${bold}${green}${cmd.name.padEnd(14)}${reset}${dim}${cmd.description}${reset}`);
            console.log(`  ${' '.repeat(14)}${gray}${cmd.usage}${reset}`);
            console.log('');
        }

        // User commands in ~/.tyr/commands/
        if (!fs.existsSync(commandsDir)) {
            console.log(separator);
            console.log(`  ${yellow}Commands folder not found: ${commandsDir}${reset}`);
            console.log('');
            return;
        }

        const files = fs.readdirSync(commandsDir)
            .filter(f => f.endsWith('.tyr.ts'))
            .sort();

        if (files.length === 0) {
            console.log(separator);
            console.log(`  ${dim}No commands in ${commandsDir}${reset}`);
            console.log('');
            return;
        }

        console.log(separator);
        console.log('');
        console.log(`  ${bold}${yellow}User commands${reset}  ${gray}(~/.tyr/commands/)${reset}`);
        console.log('');

        for (const file of files) {
            const doc = parseCommandDoc(path.join(commandsDir, file));

            console.log(`  ${bold}${green}${doc.name}${reset}`);

            if (doc.description) {
                for (const line of doc.description.split('\n')) {
                    console.log(`  ${dim}${line}${reset}`);
                }
            } else {
                console.log(`  ${gray}No description${reset}`);
            }

            if (doc.usage) {
                console.log('');
                console.log(`  ${gray}  Usage:${reset}`);
                for (const line of doc.usage.split('\n')) {
                    console.log(`  ${cyan}    ${line}${reset}`);
                }
            }

            console.log('');
        }

        console.log(separator);
        console.log(`  ${dim}Generate a new command with ${cyan}tyr gen <name> "<what it should do>"${reset}`);
        console.log('');
    };
}
