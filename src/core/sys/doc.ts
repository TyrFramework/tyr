/**
 * @fileoverview Built-in `tyr doc` command — serves a live, browsable HTML reference for every
 * Manager in `src/lib/*.ts` by parsing their own JSDoc comments (the `@class`/`@method`/
 * `@description`/`@example` tags you'll see throughout that directory) directly out of the
 * `.ts` source at request time. There is no separate "docs build" step: this file IS the doc
 * generator, and it only ever reads from `frameworkRoot`, so it always reflects whatever Managers
 * are actually installed in this copy of Tyr.
 *
 * The page also has a second, independent "User Commands" section listing every command in
 * `~/.tyr/commands/*.tyr.ts`. As of this file's `@description`/`@example` support, commands are
 * documented with the exact same JSDoc tags as Managers — see `parseCommandJSDoc()` (imported from
 * `sys/help.ts`, which parses the same comment for `tyr --help`) — including multiple `@example`
 * blocks per command, rendered here just like a Manager method's example. This is still
 * user-authored content though, unrelated to the framework's own reference above it: an
 * undocumented command shows up with "No description." instead of being skipped.
 *
 * Also demonstrates a command that starts a long-running local HTTP server rather than doing one
 * thing and exiting (compare with the request/response cycle in `sys/chat.ts`).
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { TyrContext } from '../Kernel';
import { buildDocsData } from './docData';

/**
 * @method doc (default export)
 * @description Starts a local HTTP server (default port 3000) serving a single-page HTML
 * reference built by scanning every `.ts` file in `src/lib/` for JSDoc comments, plus a hardcoded
 * "TyrContext (Kernel)" section documenting `run`/`task`/`fail`/`logger`, and a "User Commands"
 * section listing every command found in `~/.tyr/commands/*.tyr.ts`, documented with the same
 * `@description`/`@example` tags as a Manager (multiple `@example` blocks are supported and each
 * rendered on its own). The page also exposes a `POST /generate` endpoint that shells out to the
 * `ai` command (via `run('ai', [name, prompt])`) so a command can be scaffolded from natural
 * language directly from the docs UI.
 * @param {TyrContext} context - Only `logger`, `frameworkRoot`, `userRoot` and `run` are needed here.
 * @returns {(args: string[]) => Promise<void>} Handler (ignores `args`); keeps the process alive
 *   until interrupted (Ctrl+C) since `server.listen()` never resolves on its own.
 * @example
 * // tyr doc
 * // -> TS documentation ready at: http://localhost:3000
 */
export default function doc({ logger, frameworkRoot, userRoot, run }: TyrContext) {
    return async (args: string[]) => {
        logger.info("📚 Generating system documentation (TS Mode)...");

        // Every description/example/usage string below is interpolated straight into the HTML
        // template further down — none of it is escaped at the source. CLI docs are full of
        // "<...>" placeholder syntax (`<name>`, `<directory>`, `[--port <n>]`) and generic types
        // (`Promise<T>`, `Record<string, any>`); left unescaped, a browser silently swallows those
        // as unknown HTML tags, so the parameter placeholder just vanishes from the rendered page.
        // Every dynamic value gets run through this before being placed inside the HTML below.
        const escapeHtml = (text: string): string =>
            String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

        // Manager and command descriptions are written in the same JSDoc dialect used throughout
        // this codebase, which includes TypeDoc-style `{@link Something}` cross-references (see
        // e.g. AIContextManager.ts's file header). This hand-rolled parser doesn't resolve those —
        // left alone, `escapeHtml()` passes them through untouched and the page shows the literal
        // "{@link Container}" text. Run AFTER escapeHtml() (curly braces survive escaping, so the
        // pattern still matches) and turns each one into a small inline cross-reference link: if
        // the target happens to be another card's id (a Manager's class name), clicking it jumps
        // there; if not (e.g. `{@link AGENT_TOOLS}`, a constant with no card of its own), the link
        // just does nothing when clicked — cheaper than trying to resolve every possible target.
        const linkifyJSDoc = (escaped: string): string =>
            escaped.replace(/\{@link\s+([^\s}|]+)(?:[|\s][^}]*)?\}/g, '<a href="#$1" class="xref">$1</a>');

        // The one path used for prose (descriptions) that may legitimately contain `{@link ...}`
        // tags. Code examples go through escapeHtml() alone — a code block isn't prose and
        // shouldn't have parts of it silently turned into links.
        const renderText = (text: string): string => linkifyJSDoc(escapeHtml(text));

        const libPath = path.resolve(frameworkRoot, 'src/lib');

        if (!fs.existsSync(libPath)) {
            logger.error(`Library folder not found: ${libPath}`);
            return;
        }

        const { systemContext, modules, commands: commandDocs } = buildDocsData({ frameworkRoot, userRoot });

        if (modules.length === 0) {
            logger.warn("No .ts files found in /src/lib to document.");
        }

        const docs = [systemContext, ...modules];

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
                a.xref { display: inline; margin: 0; padding: 0; border-radius: 0; font-family: monospace; text-decoration: underline dotted; }
                a.xref:hover { background: none; color: #6dc9ff; }
                main { flex: 1; overflow-y: auto; }
                .card { background: #2d2d2d; padding: 20px; margin-bottom: 30px; border-radius: 8px; border: 1px solid #333; }
                h2 { border-bottom: 1px solid #444; padding-bottom: 10px; margin-top: 0; color: #fff; }
                .method { margin-top: 25px; padding-left: 15px; border-left: 3px solid #4db8ff; }
                h3 { margin: 0 0 5px 0; color: #4db8ff; font-family: monospace; font-size: 1.2em; }
                .desc { color: #ccc; margin-bottom: 10px; white-space: pre-wrap; }
                .card-desc { font-size: 1.1em; color: #bbb; white-space: pre-wrap; }
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
                ${docs.map(d => `<a href="#${d.name}">📦 ${escapeHtml(d.name.replace('.ts', ''))}</a>`).join('')}
                <h3 style="color: #888; text-transform: uppercase; font-size: 0.8rem; margin-top: 20px;">User Commands</h3>
                ${commandDocs.length > 0
                    ? commandDocs.map(c => `<a href="#cmd-${c.name}">🧭 ${escapeHtml(c.name)}</a>`).join('')
                    : `<span style="display:block; padding: 5px; color: #666; font-size: 0.85em;">None in ~/.tyr/commands/</span>`}
            </nav>
            <main>
                ${docs.map(d => `
                    <div id="${d.name}" class="card">
                        <h2>${escapeHtml(d.name)} <span class="tag-ts">TS</span></h2>
                        <p class="card-desc">${renderText(d.description)}</p>
                        ${d.methods.map(m => `
                            <div class="method">
                                <h3>${escapeHtml(m.name)}()</h3>
                                <p class="desc">${renderText(m.description)}</p>
                                ${m.example ? `<pre>${escapeHtml(m.example)}</pre>` : ''}
                            </div>
                        `).join('')}
                    </div>
                `).join('')}

                <h2 style="color: #fff; margin: 10px 0 20px; font-size: 1.4em;">🧭 User Commands <span style="color:#888; font-size: 0.6em; font-weight: normal;">(~/.tyr/commands/)</span></h2>
                ${commandDocs.length > 0
                    ? commandDocs.map(c => `
                        <div id="cmd-${c.name}" class="card">
                            <h2>${escapeHtml(c.name)} <span class="tag-ts" style="background:#2e8b57;">CMD</span></h2>
                            <p class="card-desc">${c.description ? renderText(c.description) : 'No description.'}</p>
                            ${c.examples.map((example, i) => `
                                <div class="method">
                                    <h3>${c.examples.length > 1 ? `Example ${i + 1}` : 'Example'}</h3>
                                    <pre>${escapeHtml(example)}</pre>
                                </div>
                            `).join('')}
                        </div>
                    `).join('')
                    : `<div class="card"><p class="desc">No commands found in ~/.tyr/commands/. Create one with <code>tyr gen &lt;name&gt; &lt;file&gt;</code>.</p></div>`}
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