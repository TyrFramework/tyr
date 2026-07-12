/**
 * @fileoverview Built-in `tyr doc` command — serves a live, browsable HTML reference for every
 * Manager in `src/lib/*.ts` by parsing their own JSDoc comments (the `@class`/`@method`/
 * `@description`/`@example` tags you'll see throughout that directory) directly out of the
 * `.ts` source at request time. There is no separate "docs build" step: this file IS the doc
 * generator, and it only ever reads from `frameworkRoot`, so it always reflects whatever Managers
 * are actually installed in this copy of Tyr.
 *
 * Also demonstrates a command that starts a long-running local HTTP server rather than doing one
 * thing and exiting (compare with the request/response cycle in `sys/chat.ts`).
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { TyrContext } from '../Kernel';

interface DocMethod {
    name: string;
    description: string;
    example: string | null;
}

interface DocStructure {
    name: string;
    description: string;
    methods: DocMethod[];
}

/**
 * @method doc (default export)
 * @description Starts a local HTTP server (default port 3000) serving a single-page HTML
 * reference built by scanning every `.ts` file in `src/lib/` for JSDoc comments, plus a hardcoded
 * "TyrContext (Kernel)" section documenting `run`/`task`/`fail`/`logger`. The page also exposes a
 * `POST /generate` endpoint that shells out to the `ai` command (via `run('ai', [name, prompt])`)
 * so a command can be scaffolded from natural language directly from the docs UI.
 * @param {TyrContext} context - Only `logger`, `frameworkRoot` and `run` are needed here.
 * @returns {(args: string[]) => Promise<void>} Handler (ignores `args`); keeps the process alive
 *   until interrupted (Ctrl+C) since `server.listen()` never resolves on its own.
 * @example
 * // tyr doc
 * // -> TS documentation ready at: http://localhost:3000
 */
export default function doc({ logger, frameworkRoot, run }: TyrContext) {
    return async (args: string[]) => {
        logger.info("📚 Generating system documentation (TS Mode)...");

        const libPath = path.resolve(frameworkRoot, 'src/lib');

        // A hand-rolled JSDoc parser (not a real one, e.g. TypeDoc) — deliberately minimal: it
        // only understands the small vocabulary of tags this codebase's Managers actually use
        // (@class/@description for the file's main class, @method/@description/@example per
        // method), via regex over the raw source rather than a real AST. Good enough for this
        // command's purpose (a browsable reference), not a general-purpose doc tool.
        const parseJSDoc = (filename: string, content: string): DocStructure => {
            const fileDoc: DocStructure = {
                name: filename,
                description: "No description.",
                methods: []
            };

            const cleanJSDoc = (raw: string) => {
                return raw
                    .split('\n')
                    .map(line => {
                        return line.trim().replace(/^\*+\s?/, '');
                    })
                    .filter(line => line !== '')
                    .join('\n');
            };

            // Walk every /** ... */ block in the file in source order, and for each one peek at
            // the 200 characters of code immediately following it to decide what it's documenting
            // — this "peek at what comes next" trick is what lets the parser avoid a real AST: a
            // block followed by `class Foo` is the file's own class doc, one followed by a method
            // signature documents that method.
            const commentRegex = /\/\*\*([\s\S]*?)\*\//g;
            let match;

            while ((match = commentRegex.exec(content)) !== null) {
                const rawComment = match[1];
                const cleanComment = cleanJSDoc(rawComment);

                const nextCodeIndex = commentRegex.lastIndex;
                const codeSnippet = content.substring(nextCodeIndex, nextCodeIndex + 200);

                // A comment block is treated as the file's class doc if it's explicitly tagged
                // @class, OR if the code right after it starts with `export class` — covers both
                // this codebase's convention (always tagging @class explicitly) and a plain
                // untagged doc comment above a class declaration.
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

                // Prefer an explicit @method tag (this codebase's convention); otherwise fall
                // back to sniffing a `public`/`private`/`protected` method signature out of the
                // code snippet. Constructors are skipped on purpose — "constructor()" isn't a
                // useful entry in a method reference.
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
                        const textLines = cleanComment.split('\n').filter(l => !l.startsWith('@'));
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
        };

        if (!fs.existsSync(libPath)) {
            logger.error(`Library folder not found: ${libPath}`);
            return;
        }

        const files = fs.readdirSync(libPath).filter(f => f.endsWith('.ts'));

        if (files.length === 0) {
            logger.warn("No .ts files found in /src/lib to document.");
        }

        const fileDocs = files.map(file => {
            return parseJSDoc(file, fs.readFileSync(path.join(libPath, file), 'utf8'));
        });

        const systemDocs: DocStructure = {
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

        const docs = [systemDocs, ...fileDocs];

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8"> 
            <title>Tyr Docs</title>
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: #222; color: #eee; padding: 20px; display: flex; margin: 0; }
                nav { width: 220px; border-right: 1px solid #444; margin-right: 20px; padding-right: 20px; height: 100vh; overflow-y: auto; position: sticky; top: 0; }
                a { color: #4db8ff; text-decoration: none; display: block; margin: 8px 0; padding: 5px; border-radius: 4px; transition: 0.2s; }
                a:hover { background: #333; }
                main { flex: 1; overflow-y: auto; }
                .card { background: #2d2d2d; padding: 20px; margin-bottom: 30px; border-radius: 8px; border: 1px solid #333; }
                h2 { border-bottom: 1px solid #444; padding-bottom: 10px; margin-top: 0; color: #fff; }
                .method { margin-top: 25px; padding-left: 15px; border-left: 3px solid #4db8ff; }
                h3 { margin: 0 0 5px 0; color: #4db8ff; font-family: monospace; font-size: 1.2em; }
                .desc { color: #ccc; margin-bottom: 10px; }
                pre { background: #1a1a1a; padding: 15px; border-radius: 5px; overflow-x: auto; border: 1px solid #444; color: #ce9178; font-family: monospace; white-space: pre-wrap; }
                .tag-ts { background: #007acc; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 10px; vertical-align: middle; }
                .prompt-box { background: #1a1a1a; border: 2px solid #4db8ff; padding: 25px; border-radius: 8px; margin-top: 40px; position: relative; }
                .prompt-box h2 { color: #4db8ff; margin-top: 0; border: none; }
                .copy-btn { position: absolute; top: 20px; right: 20px; background: #4db8ff; color: #000; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; font-weight: bold; transition: 0.2s; }
                .copy-btn:hover { background: #6dc9ff; }
                .copy-btn:active { background: #2da3e0; }
            </style>
        </head>
        <body>
            <nav>
                <h3 style="color: #888; text-transform: uppercase; font-size: 0.8rem;">TS Modules</h3>
                ${docs.map(d => `<a href="#${d.name}">📦 ${d.name.replace('.ts', '')}</a>`).join('')}
            </nav>
            <main>
                ${docs.map(d => `
                    <div id="${d.name}" class="card">
                        <h2>${d.name} <span class="tag-ts">TS</span></h2>
                        <p style="font-size: 1.1em; color: #bbb;">${d.description}</p>
                        ${d.methods.map(m => `
                            <div class="method">
                                <h3>${m.name}()</h3>
                                <p class="desc">${m.description}</p>
                                ${m.example ? `<pre>${m.example}</pre>` : ''}
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </main>
        </body>
        </html>`;

        const PORT = 3000;
        const server = http.createServer(async (req, res) => {
            // The docs page's "generate a command from a description" form posts here. This is
            // the one place in this file that uses `run()` (TyrContext's command-composition
            // helper — see Kernel.ts) instead of calling a Manager directly: it lets the docs UI
            // trigger a full `tyr ai <name> <prompt>` invocation without doc.ts needing to know
            // anything about how that command works internally.
            if (req.method === 'POST' && req.url === '/generate') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { name, prompt } = JSON.parse(body);
                        if (!name || !prompt) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, message: 'Missing required fields.' }));
                            return;
                        }

                        await run('ai', [name, prompt]);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: `Command '${name}' generated successfully at ~/.tyr/commands/${name}.tyr.ts` }));
                    } catch (e: any) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: e.message || 'Error generating command.' }));
                    }
                });
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        });

        server.listen(PORT, () => {
            logger.success(`TS documentation ready at: http://localhost:${PORT}`);
            logger.info("Press Ctrl+C to stop.");
        });
    };
};