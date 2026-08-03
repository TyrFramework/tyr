/**
 * @fileoverview Shared data layer behind `sys/doc.ts` (live `localhost:3000` reference) and
 * `sys/docBuild.ts` (static JSON export for the `pages/docs` site). Both commands need the exact
 * same JSDoc-derived content; this file owns parsing it out of `src/lib/*.ts` and `~/.tyr/commands/`
 * once, as plain data, so the two commands only differ in what they do with the result (render HTML
 * vs. write JSON) rather than duplicating the extraction logic itself.
 */
import fs from 'fs';
import path from 'path';
import { parseCommandJSDoc } from './help';

export interface DocMethod {
    name: string;
    description: string;
    example: string | null;
}

export interface DocStructure {
    name: string;
    description: string;
    methods: DocMethod[];
}

/** A user command's doc entry for the "User Commands" section — `parseCommandJSDoc()` returns the
 *  description/examples, this just pairs them with the command's file-derived name. */
export interface CommandEntry {
    name: string;
    description: string;
    examples: string[];
}

export interface DocsData {
    systemContext: DocStructure;
    modules: DocStructure[];
    commands: CommandEntry[];
}

// A hand-rolled JSDoc parser (not a real one, e.g. TypeDoc) — deliberately minimal: it only
// understands the small vocabulary of tags this codebase's Managers actually use (@class/
// @description for the file's main class, @method/@description/@example per method), via regex
// over the raw source rather than a real AST. Good enough for a browsable reference, not a
// general-purpose doc tool.
export function parseJSDoc(filename: string, content: string): DocStructure {
    const fileDoc: DocStructure = {
        name: filename,
        description: "No description.",
        methods: []
    };

    // Strips the leading `*` (and its indentation) from every line, but keeps blank lines that
    // fall INSIDE the comment rather than dropping every empty line indiscriminately. Those blank
    // lines are how a JSDoc block marks a paragraph break (e.g. between a class's opening summary
    // and a second paragraph of detail); losing them collapsed every description into a single
    // run-on wall of text once rendered as HTML. Only the comment's own leading/trailing blank
    // lines (the ones right after `/**` and right before `*/`) are trimmed away.
    const cleanJSDoc = (raw: string) => {
        const lines = raw
            .split('\n')
            .map(line => line.trim().replace(/^\*+\s?/, ''));

        while (lines.length && lines[0] === '') lines.shift();
        while (lines.length && lines[lines.length - 1] === '') lines.pop();

        return lines.join('\n');
    };

    // Walk every /** ... */ block in the file in source order, and for each one peek at the 200
    // characters of code immediately following it to decide what it's documenting — this "peek at
    // what comes next" trick is what lets the parser avoid a real AST: a block followed by `class
    // Foo` is the file's own class doc, one followed by a method signature documents that method.
    const commentRegex = /\/\*\*([\s\S]*?)\*\//g;
    let match;

    while ((match = commentRegex.exec(content)) !== null) {
        const rawComment = match[1];
        const cleanComment = cleanJSDoc(rawComment);

        const nextCodeIndex = commentRegex.lastIndex;
        const codeSnippet = content.substring(nextCodeIndex, nextCodeIndex + 200);

        // A comment block is treated as the file's class doc if it's explicitly tagged @class, OR
        // if the code right after it starts with `export class` — covers both this codebase's
        // convention (always tagging @class explicitly) and a plain untagged doc comment above a
        // class declaration.
        const isClass = /@class/.test(cleanComment) || /^\s*export\s+class/.test(codeSnippet);

        if (isClass) {
            const descMatch = cleanComment.match(/@description\s+([\s\S]*?)(?=@|$)/i);
            if (descMatch) {
                fileDoc.description = descMatch[1].trim();
            } else {
                fileDoc.description = cleanComment.split('\n')[0];
            }
            const classNameMatch = codeSnippet.match(/class\s+(\w+)/);
            if (classNameMatch) fileDoc.name = classNameMatch[1];
            continue;
        }

        let methodName = null;

        // Prefer an explicit @method tag (this codebase's convention); otherwise fall back to
        // sniffing a `public`/`private`/`protected` method signature out of the code snippet.
        // Constructors are skipped on purpose — "constructor()" isn't a useful entry in a method
        // reference.
        const methodTagMatch = cleanComment.match(/@method\s+(\w+)/i);
        if (methodTagMatch) {
            methodName = methodTagMatch[1];
        } else if (!codeSnippet.match(/^\s*constructor/)) {
            const codeMatch = codeSnippet.match(/(?:public|private|protected)\s+(?:async\s+)?(\w+)/);
            if (codeMatch) {
                methodName = codeMatch[1];
            }
        }

        if (methodName) {
            let description = "";
            const descMatch = cleanComment.match(/@description\s+([\s\S]*?)(?=@|$)/i);
            if (descMatch) {
                description = descMatch[1].trim();
            } else {
                // No explicit @description tag — fall back to whatever plain text is in the
                // comment. Blank lines are dropped here (unlike the @description path above): with
                // no tag to delimit where the description ends, a stray blank line is more likely
                // incidental spacing before another tag than a real paragraph break.
                const textLines = cleanComment.split('\n').filter(l => l !== '' && !l.startsWith('@'));
                description = textLines.join(' ').trim() || "No description";
            }

            let example = null;
            const exampleMatch = cleanComment.match(/@example([\s\S]*?)(?=@|$)/i);
            if (exampleMatch) {
                example = exampleMatch[1]
                    .replace(/```ts|```/g, '')
                    .trim();
            }

            fileDoc.methods.push({
                name: methodName,
                description: description,
                example: example
            });
        }
    }

    return fileDoc;
}

/** The hardcoded "TyrContext (Kernel)" section documenting `run`/`task`/`fail`/`logger` — these
 *  are framework-level helpers injected into every command, not parsed from a Manager file, so
 *  they're written out by hand once here instead of being sniffed out of Kernel.ts's own JSDoc. */
export const systemContextDocs: DocStructure = {
    name: 'TyrContext (Kernel)',
    description: 'Global utilities injected into every command. Accessible by destructuring the context.',
    methods: [
        {
            name: 'run',
            description: 'Programmatically runs another system command (command composition). Useful for a command to invoke others.',
            example: `
// Calls the 'test' command passing extra arguments
const secret = "123";
args.push(secret);
await run('test', args);`.trim()
        },
        {
            name: 'task',
            description: 'Helper that wraps a critical operation. If it fails, the framework captures the error, adds context, and displays it cleanly in the console. Removes the need for manual try/catch.',
            example: `
// Example: async task that returns a value
const buildId = await task('Building project', async () => {
    return await shell.exec('npm run build');
});

// If it fails, the log will say: "Task failed: Building project"`.trim()
        },
        {
            name: 'fail',
            description: 'Stops command execution immediately by throwing a controlled error. Allows adding a "suggestion" to help the user resolve the issue.',
            example: `
// Use it for logic validations
if (!fs.existsSync('./package.json')) {
    fail(
        'npm package file not found',
        'Run "npm init -y" to generate one.'
    );
}`.trim()
        },
        {
            name: 'logger',
            description: 'Standardised logging system with colours and formats.',
            example: `logger.info('Starting...');\nlogger.success('Created');\nlogger.warn('Warning');`
        }
    ]
};

/**
 * Scans `frameworkRoot/src/lib/*.ts` for Manager JSDoc and `userRoot/commands/*.tyr.ts` for user
 * command JSDoc, returning both plus the hardcoded `systemContextDocs`, as plain data — no HTML,
 * no escaping. Callers (`doc.ts` for the live server, `docBuild.ts` for the static JSON export)
 * decide how to render or serialize it.
 */
export function buildDocsData({ frameworkRoot, userRoot }: { frameworkRoot: string; userRoot: string }): DocsData {
    const libPath = path.resolve(frameworkRoot, 'src/lib');

    const files = fs.existsSync(libPath)
        ? fs.readdirSync(libPath).filter(f => f.endsWith('.ts'))
        : [];

    const modules = files.map(file =>
        parseJSDoc(file, fs.readFileSync(path.join(libPath, file), 'utf8'))
    );

    const commandsDir = path.join(userRoot, 'commands');
    const commands: CommandEntry[] = fs.existsSync(commandsDir)
        ? fs.readdirSync(commandsDir)
            .filter(f => f.endsWith('.tyr.ts'))
            .sort()
            .map(file => {
                const name = path.basename(file, '.tyr.ts');
                const { description, examples } = parseCommandJSDoc(path.join(commandsDir, file));
                return { name, description, examples };
            })
        : [];

    return { systemContext: systemContextDocs, modules, commands };
}
