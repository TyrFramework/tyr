/**
 * @fileoverview Built-in `tyr --help` command. Unlike the other `sys/*` commands, this is invoked
 * directly from `Kernel.handle()`'s `--help`/`-h` branch with a hand-built, minimal context (see
 * that branch's `helpContext`) rather than the full one — `help` only ever needs `userRoot`, so it
 * doesn't require the rest of the Container to be meaningfully usable.
 *
 * Prints two sections: the framework's own built-in commands (hardcoded in `builtins` below — kept
 * in sync with `Kernel.handle()` by hand, there is no single source of truth shared between the
 * two) and every user command found in `~/.tyr/commands/*.tyr.ts`, whose description/examples are
 * scraped from that file's own leading comment (see `parseCommandJSDoc`) — the very same
 * `@description`/`@example` JSDoc tags used to document Managers in `src/lib/*.ts` (see
 * `sys/doc.ts`'s `parseJSDoc`), so a command is documented the same way regardless of whether it's
 * read from the terminal (here) or from the `tyr doc` HTML reference.
 */
import fs from 'fs';
import path from 'path';
import { TyrContext } from '../Kernel';

/** Description/usage extracted from a user command's leading comment — see `parseCommandDoc()`.
 *  Exported so other `sys/*` commands (currently `doc.ts`, for its "User Commands" section) can
 *  reuse the exact same parsing instead of re-implementing it slightly differently. */
export interface CommandDoc {
    name: string;
    description: string;
    usage: string;
}

/** Description plus every `@example` block found in a command's leading comment, in source order.
 *  The lower-level result `parseCommandJSDoc()` returns — `doc.ts`'s "User Commands" section uses
 *  this directly (one `<pre>` per example, exactly like a Manager method's `@example`); `help.ts`'s
 *  own `parseCommandDoc()` collapses `examples` into a single `usage` string for the terminal. */
export interface CommandJSDoc {
    description: string;
    examples: string[];
}

/** Drops only the blank lines at the very start/end of an array of lines, leaving blank lines in
 *  the middle untouched. Used to trim a comment block's own leading/trailing padding without
 *  destroying blank lines the author used as paragraph breaks inside the description — a plain
 *  `.filter(l => l.trim() !== '')` would strip those paragraph breaks along with the padding. */
function trimBlankEdges(lines: string[]): string[] {
    const trimmed = [...lines];
    while (trimmed.length && trimmed[0].trim() === '') trimmed.shift();
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    return trimmed;
}

/**
 * Extracts the description and every `@example` block from the first `/** ... *\/` comment at the
 * top of a `.tyr.ts` file, using the same JSDoc vocabulary `sys/doc.ts`'s `parseJSDoc` reads for
 * Managers: `@description` for the description text, and one or more `@example` blocks for usage
 * examples (unlike a Manager method, which only ever needs one). A file with no leading comment
 * returns an empty description and no examples rather than throwing — commands are never required
 * to be documented.
 *
 * For a command still using the older, pre-JSDoc convention (a plain comment with everything
 * before a `uso:` line as the description and everything after as a single usage example, with no
 * `@description`/`@example` tags at all), this still degrades gracefully to roughly the same
 * result — new commands should prefer `@description`/`@example`, but nothing breaks for old ones.
 */
export function parseCommandJSDoc(filePath: string): CommandJSDoc {
    const content = fs.readFileSync(filePath, 'utf-8');

    const match = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (!match) return { description: '', examples: [] };

    const lines = match[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trimEnd());
    const cleaned = trimBlankEdges(lines).join('\n');

    let description = '';
    // `@fileoverview` is accepted as a fallback source for the description, not just
    // `@description`: it's a standard JSDoc tag, and it's the exact tag this codebase's own
    // Managers use for their file-level header comment (see e.g. AIContextManager.ts) — a command
    // documented the same way shouldn't get a broken result just because it used `@fileoverview`
    // instead of `@description`. Tried in order; `@description` wins if a comment has both.
    const descMatch =
        cleaned.match(/@description\s+([\s\S]*?)(?=\n\s*@\w|$)/i) ??
        cleaned.match(/@fileoverview\s+([\s\S]*?)(?=\n\s*@\w|$)/i);
    if (descMatch) {
        description = descMatch[1].trim();
    }

    // Unlike the single-@example lookahead in doc.ts's parseJSDoc (`(?=@|$)`), this requires the
    // next tag's `@` to start a new line — deliberately, since this loop can match several
    // @example blocks in the same comment, and a bare `(?=@|$)` would truncate an example early
    // if its own code happens to contain an unrelated "@" (an email address, a decorator, ...).
    const examples: string[] = [];
    const exampleRegex = /@example\b([\s\S]*?)(?=\n\s*@\w|$)/gi;
    let exampleMatch: RegExpExecArray | null;
    while ((exampleMatch = exampleRegex.exec(cleaned)) !== null) {
        const example = exampleMatch[1].replace(/```ts|```/g, '').trim();
        if (example) examples.push(example);
    }

    // Nothing tagged with @description/@example at all — fall back to the pre-JSDoc convention
    // (description before a `uso:` line, usage after it), or, failing that, the whole comment as
    // a plain description.
    if (!descMatch && examples.length === 0) {
        const rawLines = cleaned.split('\n');
        const usoIndex = rawLines.findIndex(l => /^uso:/i.test(l.trim()));

        if (usoIndex !== -1) {
            description = trimBlankEdges(rawLines.slice(0, usoIndex)).join('\n');
            const usage = rawLines
                .slice(usoIndex + 1)
                .filter(l => l.trim() !== '')
                .map(l => l.trim())
                .join('\n')
                .trim();
            if (usage) examples.push(usage);
        } else {
            description = cleaned;
        }
    } else if (!descMatch) {
        // @example is present but @description isn't — still show whatever plain text precedes
        // the first @-tag as the description, instead of leaving it empty.
        const firstTagIndex = cleaned.split('\n').findIndex(l => /^@\w/.test(l.trim()));
        if (firstTagIndex > 0) {
            description = trimBlankEdges(cleaned.split('\n').slice(0, firstTagIndex)).join('\n');
        }
    }

    return { description, examples };
}

/**
 * Extracts a user command's description and usage from its leading comment, in the `{name,
 * description, usage}` shape `tyr --help`'s rendering loop expects — a thin wrapper around
 * `parseCommandJSDoc()` that joins multiple `@example` blocks into one `usage` string (each
 * separated by a blank line), since the terminal only ever shows one "Usage:" block per command.
 */
export function parseCommandDoc(filePath: string): CommandDoc {
    const fileName = path.basename(filePath, '.tyr.ts');
    const { description, examples } = parseCommandJSDoc(filePath);
    return { name: fileName, description, usage: examples.join('\n\n') };
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
