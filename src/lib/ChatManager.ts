/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.chat`. Deliberately AI-agnostic (see the class doc below): it
 * owns the local web server, the chat/file-browser UI, session and "context of interest" state,
 * and a small event-hook API (`onMessage`/`on`) — but never calls an AI vendor itself. `sys/chat.ts`
 * is the reference example of wiring this Manager together with {@link AIVendorManager} to answer
 * messages.
 */
import { EventEmitter } from 'node:events';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';
import { FileSystemManager } from './FileSystemManager.js';

export type ChatRole = 'user' | 'assistant' | 'error';

export interface ChatAttachment {
    id: string;
    filename: string;
    path: string;
    mimeType: string;
    size: number;
}

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
    attachments: ChatAttachment[];
    createdAt: number;
}

/** Opaque "effort ceiling" selector rendered in the chat header — ChatManager never interprets
 *  these strings (it doesn't know what a TaskPriority is, by design), it just displays `levels`
 *  and forwards whichever one the user picks via the 'priority:change' event. The caller (e.g.
 *  a command wiring AIVendorManager) decides what the values mean and what to do with a change. */
export interface ChatPriorityCeilingOptions {
    levels: string[];
    initial: string;
}

export interface ChatOpenOptions {
    /** Preferred port. If busy, the next free port is used instead (default: 4646). */
    port?: number;
    /** Browser tab / header title (default: "Tyr Chat — <dirname>"). */
    title?: string;
    /** Initial fraction of the width given to the chat pane, 0.2–0.8 (default: 0.4). The user
     *  can still resize it live by dragging the divider between the two panes. */
    splitRatio?: number;
    /** Renders an effort-ceiling dropdown in the chat header when provided. Omit to skip it entirely. */
    priorityCeiling?: ChatPriorityCeilingOptions;
}

export interface ChatSession {
    id: string;
    dir: string;
    /** Temp folder where attached images are written. Removed on stop() / process exit. */
    tempDir: string;
    port: number;
    url: string;
    stop: () => Promise<void>;
}

export interface ChatMessageContext {
    message: ChatMessage;
    /** Full conversation so far, including the message that triggered this call. */
    history: ChatMessage[];
    dir: string;
    /** Id of the session this message belongs to — pass it to addToContext()/removeFromContext()
     *  /getContext() to read or grow the "context of interest" file set while producing a reply. */
    sessionId: string;
    /** Snapshot (sorted, relative to `dir`) of the context-of-interest file set at the moment the
     *  handler was invoked. Mutations made via addToContext() during the handler are NOT reflected
     *  here — call getContext(sessionId) again for the live set. */
    context: string[];
}

/** Function that produces the assistant's reply text for a user message. Registered via
 *  chat.onMessage() — this is where a consumer wires in an AI vendor, a static responder, etc. */
export type ChatMessageHandler = (ctx: ChatMessageContext) => Promise<string> | string;

export type ChatEventName =
    | 'chat:open'
    | 'chat:close'
    | 'message:send'
    | 'message:response'
    | 'message:error'
    | 'file:select'
    | 'context:change'
    | 'priority:change';

interface InternalSession {
    id: string;
    dir: string;
    tempDir: string;
    port: number;
    server: http.Server;
    history: ChatMessage[];
    attachments: Map<string, ChatAttachment>;
    splitRatio: number;
    title: string;
    /** "Context of interest" — relative (forward-slash) paths of files the conversation is
     *  currently grounded on: added by a double-click in the file browser, or programmatically
     *  via addToContext() (e.g. a command detecting a file mention, or the AI itself asking for
     *  one through a tool). Highlighted in the file browser (see /api/context). */
    contextFiles: Set<string>;
    /** Current value of the effort-ceiling dropdown, if the caller opted into one via
     *  ChatOpenOptions.priorityCeiling. `current` is mutated by POST /api/priority-ceiling. */
    priorityCeiling?: { levels: string[]; current: string };
}

const DEFAULT_PORT = 4646;
const MAX_PORT_ATTEMPTS = 20;
const MAX_PREVIEW_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 30_000_000;
const IGNORED_ENTRIES = new Set(['node_modules', '.git', '.DS_Store']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/plain',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
};

function mimeFromExt(ext: string): string {
    return MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * @class ChatManager
 * @description Runs a self-contained local web app — chat on one side, a file browser for a
 * given directory on the other — and gives commands a hook-based API to drive it. The manager
 * itself never talks to an AI vendor: the caller registers `onMessage()` to decide how a reply
 * is produced (e.g. by calling AIVendorManager), and can subscribe to lifecycle events with
 * `on()` for side effects (logging, persistence, analytics...) around sends, responses, errors
 * and file selection.
 *
 * Attached images are written to a per-session temp directory (via os.tmpdir()) that is removed
 * when the session is stopped or the process exits (SIGINT/SIGTERM/exit are all hooked).
 *
 * Each session also tracks a "context of interest" file set (addToContext() / removeFromContext()
 * / toggleContext() / getContext()) — files the file browser highlights and that ChatMessageContext
 * exposes to the onMessage handler, so a caller can ground replies on specific files without the
 * model having to re-discover them every turn. The manager only tracks *which* paths are of
 * interest and validates them (must exist, must be a file, must stay inside `dir`); reading their
 * content and deciding what counts as "mentioned" is left to the onMessage handler, same division
 * of responsibility as AI content generation itself.
 */
export class ChatManager {
    private fsManager: FileSystemManager;
    private logger: Logger;
    private emitter = new EventEmitter();
    private messageHandler: ChatMessageHandler | null = null;
    private sessions = new Map<string, InternalSession>();
    private exitHooked = false;

    constructor(fsManager: FileSystemManager, logger: Logger) {
        this.fsManager = fsManager;
        this.logger = logger;
    }

    /**
     * @method onMessage
     * @description Registers the function responsible for producing the assistant's reply to a
     * user message. There is a single active handler per manager instance — call again to
     * replace it. If no handler is registered, incoming messages fail with a TyrError.
     * @param {ChatMessageHandler} handler - Receives { message, history, dir }, returns reply text.
     * @example
     * chat.onMessage(async ({ message, history, dir }) => {
     *   const result = await aiVendor.complete([
     *     { role: 'system', content: `You are assisting inside ${dir}.` },
     *     ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
     *   ]);
     *   return result.content;
     * });
     */
    public onMessage(handler: ChatMessageHandler): void {
        this.messageHandler = handler;
    }

    /**
     * @method on
     * @description Subscribes to a chat lifecycle event. Multiple listeners can be registered
     * per event; each is awaited in turn, and a throwing listener is logged and skipped rather
     * than breaking the request.
     * @param {ChatEventName} event - One of: chat:open, chat:close, message:send, message:response, message:error, file:select.
     * @param {Function} listener - Called with an event-specific payload object.
     * @example
     * chat.on('message:send', ({ message }) => logger.info(`User sent: ${message.text}`));
     * chat.on('message:response', ({ message }) => logger.info(`Assistant replied: ${message.text}`));
     */
    public on(event: ChatEventName, listener: (...args: any[]) => void): void {
        this.emitter.on(event, listener);
    }

    /**
     * @method off
     * @description Removes a previously registered event listener.
     * @param {ChatEventName} event - The event name passed to on().
     * @param {Function} listener - The exact listener function reference to remove.
     * @example
     * chat.off('file:select', myListener);
     */
    public off(event: ChatEventName, listener: (...args: any[]) => void): void {
        this.emitter.off(event, listener);
    }

    private normalizeRelPath(relPath: string): string {
        return (relPath || '')
            .replace(/\\/g, '/')
            .replace(/^(\.\/)+/, '')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
    }

    /**
     * @method getContext
     * @description Returns the session's current "context of interest" — relative paths, sorted.
     * @param {string} sessionId - The id of the session (see ChatMessageContext.sessionId).
     * @returns {string[]} Sorted relative paths.
     * @example
     * const files = chat.getContext(sessionId);
     */
    public getContext(sessionId: string): string[] {
        const session = this.sessions.get(sessionId);
        if (!session) return [];
        return [...session.contextFiles].sort();
    }

    /**
     * @method addToContext
     * @description Adds one or more files to the session's context of interest. Each path is
     * validated (must resolve inside the session's directory, must exist, must be a file) and
     * silently skipped if it fails — invalid input never throws, since callers (mention detection,
     * an AI tool call) work off untrusted text. Fires 'context:change' once if anything was added.
     * @param {string} sessionId - The id of the session.
     * @param {string[]} relPaths - Paths relative to the session's directory.
     * @returns {Promise<string[]>} The subset of paths that were actually added (newly, validly).
     * @example
     * const added = await chat.addToContext(sessionId, ['src/index.ts']);
     */
    public async addToContext(sessionId: string, relPaths: string[]): Promise<string[]> {
        const session = this.sessions.get(sessionId);
        if (!session) return [];

        const added: string[] = [];
        for (const raw of relPaths) {
            const normalized = this.normalizeRelPath(raw);
            if (!normalized || session.contextFiles.has(normalized)) continue;

            let abs: string;
            try {
                abs = this.resolveSafe(session, normalized);
            } catch {
                continue;
            }
            if (!fsSync.existsSync(abs) || !fsSync.statSync(abs).isFile()) continue;

            session.contextFiles.add(normalized);
            added.push(normalized);
        }

        if (added.length > 0) {
            await this.emitSafe('context:change', { sessionId, dir: session.dir, files: this.getContext(sessionId) });
        }
        return added;
    }

    /**
     * @method removeFromContext
     * @description Removes a single file from the session's context of interest, if present.
     * Fires 'context:change' when it actually removes something.
     * @param {string} sessionId - The id of the session.
     * @param {string} relPath - Path relative to the session's directory.
     * @example
     * await chat.removeFromContext(sessionId, 'src/index.ts');
     */
    public async removeFromContext(sessionId: string, relPath: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const normalized = this.normalizeRelPath(relPath);
        if (session.contextFiles.delete(normalized)) {
            await this.emitSafe('context:change', { sessionId, dir: session.dir, files: this.getContext(sessionId) });
        }
    }

    /**
     * @method toggleContext
     * @description Adds `relPath` to the context of interest if absent, removes it if present —
     * the file browser's double-click behaviour. Same validation as addToContext() on the add path.
     * @param {string} sessionId - The id of the session.
     * @param {string} relPath - Path relative to the session's directory.
     * @returns {Promise<{ added: boolean; files: string[] }>} Whether the path ended up added, and the resulting set.
     * @example
     * const { added } = await chat.toggleContext(sessionId, 'src/index.ts');
     */
    public async toggleContext(sessionId: string, relPath: string): Promise<{ added: boolean; files: string[] }> {
        const session = this.sessions.get(sessionId);
        if (!session) return { added: false, files: [] };

        const normalized = this.normalizeRelPath(relPath);
        if (session.contextFiles.has(normalized)) {
            await this.removeFromContext(sessionId, normalized);
            return { added: false, files: this.getContext(sessionId) };
        }

        const added = await this.addToContext(sessionId, [normalized]);
        return { added: added.length > 0, files: this.getContext(sessionId) };
    }

    private async emitSafe(event: ChatEventName, payload: any): Promise<void> {
        for (const listener of this.emitter.listeners(event)) {
            try {
                await listener(payload);
            } catch (e) {
                this.logger.warn(`Chat hook '${event}' threw: ${(e as Error).message}`);
            }
        }
    }

    private registerExitCleanup(): void {
        if (this.exitHooked) return;
        this.exitHooked = true;

        const cleanup = () => {
            for (const session of this.sessions.values()) {
                try {
                    fsSync.rmSync(session.tempDir, { recursive: true, force: true });
                } catch {
                    // best-effort cleanup on shutdown
                }
            }
        };

        process.once('exit', cleanup);
        process.once('SIGINT', () => { cleanup(); process.exit(0); });
        process.once('SIGTERM', () => { cleanup(); process.exit(0); });
    }

    /**
     * @method open
     * @description Starts the chat + file browser server for a directory. Returns immediately
     * once the server is listening; the returned session exposes the URL to open and a stop()
     * to shut the server down and delete the temp attachments folder.
     * @param {string} dir - Directory to browse (also used as the chat's working context).
     * @param {ChatOpenOptions} options - port, title, splitRatio (see type for defaults).
     * @returns {Promise<ChatSession>} The running session.
     * @example
     * const session = await chat.open('./my-project', { splitRatio: 0.35 });
     * logger.success(`Chat ready at ${session.url}`);
     */
    public async open(dir: string, options: ChatOpenOptions = {}): Promise<ChatSession> {
        const resolvedDir = path.resolve(this.fsManager.expandPath(dir));

        if (!this.fsManager.exists(resolvedDir)) {
            throw new TyrError(`Directory not found: ${resolvedDir}`, null, 'Pass an existing directory to chat.open().');
        }
        if (!fsSync.statSync(resolvedDir).isDirectory()) {
            throw new TyrError(`Not a directory: ${resolvedDir}`);
        }

        const id = crypto.randomUUID();
        const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'tyr-chat-'));
        const splitRatio = Math.min(0.8, Math.max(0.2, options.splitRatio ?? 0.4));
        const title = options.title ?? `Tyr Chat — ${path.basename(resolvedDir)}`;

        const session: InternalSession = {
            id,
            dir: resolvedDir,
            tempDir,
            port: 0,
            server: null as unknown as http.Server,
            history: [],
            attachments: new Map(),
            splitRatio,
            title,
            contextFiles: new Set(),
            priorityCeiling: options.priorityCeiling
                ? { levels: options.priorityCeiling.levels, current: options.priorityCeiling.initial }
                : undefined,
        };

        const server = http.createServer((req, res) => {
            this.handleRequest(session, req, res);
        });
        session.server = server;

        try {
            session.port = await this.listen(server, options.port ?? DEFAULT_PORT);
        } catch (e) {
            fsSync.rmSync(tempDir, { recursive: true, force: true });
            throw new TyrError('Could not start chat server', e, 'Pass a free port via options.port.');
        }

        this.sessions.set(id, session);
        this.registerExitCleanup();

        const chatSession: ChatSession = {
            id,
            dir: resolvedDir,
            tempDir,
            port: session.port,
            url: `http://localhost:${session.port}`,
            stop: () => this.stop(id),
        };

        await this.emitSafe('chat:open', { session: chatSession });
        return chatSession;
    }

    private listen(server: http.Server, preferredPort: number): Promise<number> {
        return new Promise((resolve, reject) => {
            let attempt = 0;

            const tryPort = (port: number) => {
                const onError = (err: NodeJS.ErrnoException) => {
                    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
                        attempt++;
                        tryPort(port + 1);
                    } else {
                        reject(err);
                    }
                };
                server.once('error', onError);
                server.listen(port, () => {
                    server.removeListener('error', onError);
                    const address = server.address();
                    resolve(typeof address === 'object' && address ? address.port : port);
                });
            };

            tryPort(preferredPort);
        });
    }

    /**
     * @method stop
     * @description Stops a running chat session: closes the HTTP server and deletes its temp
     * attachments folder. Safe to call more than once.
     * @param {string} sessionId - The id of the session returned by open().
     * @example
     * await session.stop();
     */
    public async stop(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        await this.emitSafe('chat:close', { sessionId, dir: session.dir, history: session.history });
        await new Promise<void>((resolve) => session.server.close(() => resolve()));

        try {
            fsSync.rmSync(session.tempDir, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }

        this.sessions.delete(sessionId);
    }

    // --- HTTP plumbing --------------------------------------------------------------------------

    private sendJson(res: ServerResponse, status: number, payload: any): void {
        const body = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
    }

    private readJsonBody(req: IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
                if (raw.length > MAX_UPLOAD_BYTES) req.destroy(new Error('Payload too large'));
            });
            req.on('end', () => {
                if (!raw) { resolve({}); return; }
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(new TyrError('Invalid JSON body', e));
                }
            });
            req.on('error', reject);
        });
    }

    private resolveSafe(session: InternalSession, relPath: string): string {
        const cleaned = (relPath || '').replace(/^\/+/, '');
        const resolved = path.resolve(session.dir, cleaned);
        if (resolved !== session.dir && !resolved.startsWith(session.dir + path.sep)) {
            throw new TyrError('Path escapes the chat directory', null, 'Do not use ".." in file paths.');
        }
        return resolved;
    }

    private async handleRequest(session: InternalSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const pathname = url.pathname;

            if (pathname === '/' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.renderPage(session));
                return;
            }

            if (pathname === '/api/history' && req.method === 'GET') {
                this.sendJson(res, 200, {
                    history: session.history,
                    dir: session.dir,
                    splitRatio: session.splitRatio,
                    title: session.title,
                });
                return;
            }

            if (pathname === '/api/context' && req.method === 'GET') {
                this.sendJson(res, 200, { files: this.getContext(session.id) });
                return;
            }

            if (pathname === '/api/context/toggle' && req.method === 'POST') {
                const body = await this.readJsonBody(req);
                const relPath = typeof body?.path === 'string' ? body.path : '';
                if (!relPath) throw new TyrError('Missing path', null, 'Send { path } to /api/context/toggle.');
                const result = await this.toggleContext(session.id, relPath);
                this.sendJson(res, 200, result);
                return;
            }

            if (pathname === '/api/priority-ceiling' && req.method === 'POST') {
                const body = await this.readJsonBody(req);
                const value = typeof body?.value === 'string' ? body.value : '';
                if (!session.priorityCeiling || !session.priorityCeiling.levels.includes(value)) {
                    throw new TyrError('Invalid priority ceiling value', null, 'Send one of the values from BOOTSTRAP.priorityCeiling.levels.');
                }
                session.priorityCeiling.current = value;
                await this.emitSafe('priority:change', { sessionId: session.id, dir: session.dir, value });
                this.sendJson(res, 200, { ok: true, value });
                return;
            }

            if (pathname === '/api/tree' && req.method === 'GET') {
                const rel = url.searchParams.get('path') ?? '';
                const entries = await this.listChildren(session, rel);
                this.sendJson(res, 200, { entries });
                return;
            }

            if (pathname === '/api/file' && req.method === 'GET') {
                const rel = url.searchParams.get('path') ?? '';
                const preview = await this.readFilePreview(session, rel);
                await this.emitSafe('file:select', { path: rel, dir: session.dir });
                this.sendJson(res, 200, preview);
                return;
            }

            if (pathname === '/api/raw' && req.method === 'GET') {
                const rel = url.searchParams.get('path') ?? '';
                await this.serveRaw(session, rel, res);
                return;
            }

            if (pathname === '/api/attachment' && req.method === 'GET') {
                const id = url.searchParams.get('id') ?? '';
                await this.serveAttachment(session, id, res);
                return;
            }

            if (pathname === '/api/upload' && req.method === 'POST') {
                const body = await this.readJsonBody(req);
                const attachment = await this.saveAttachment(session, body);
                this.sendJson(res, 200, { attachment });
                return;
            }

            if (pathname === '/api/message' && req.method === 'POST') {
                const body = await this.readJsonBody(req);
                const message = await this.handleMessage(session, body);
                this.sendJson(res, 200, { message, context: this.getContext(session.id) });
                return;
            }

            this.sendJson(res, 404, { error: 'Not found' });
        } catch (e: any) {
            const code = e?.originalError?.code ?? e?.code;
            const status = code === 'ENOENT' ? 404 : e instanceof TyrError ? 400 : 500;
            this.sendJson(res, status, { error: e?.message ?? 'Internal error' });
        }
    }

    // --- File browser -----------------------------------------------------------------------

    private async listChildren(session: InternalSession, relPath: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
        const absDir = this.resolveSafe(session, relPath);
        const dirents = await fsp.readdir(absDir, { withFileTypes: true });
        const base = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

        return dirents
            .filter((d) => !IGNORED_ENTRIES.has(d.name))
            .map((d) => ({
                name: d.name,
                path: base ? `${base}/${d.name}` : d.name,
                isDir: d.isDirectory(),
            }))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    }

    private async readFilePreview(session: InternalSession, relPath: string): Promise<{
        path: string; binary: boolean; truncated: boolean; content: string | null; size: number; isImage: boolean;
    }> {
        const abs = this.resolveSafe(session, relPath);
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) throw new TyrError('Cannot preview a directory');

        const ext = path.extname(abs).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
            return { path: relPath, binary: true, truncated: false, content: null, size: stat.size, isImage: true };
        }

        const readLength = Math.min(stat.size, MAX_PREVIEW_BYTES);
        const buffer = Buffer.alloc(readLength);
        const fd = await fsp.open(abs, 'r');
        try {
            await fd.read(buffer, 0, readLength, 0);
        } finally {
            await fd.close();
        }

        const binary = buffer.subarray(0, Math.min(8000, buffer.length)).includes(0);
        return {
            path: relPath,
            binary,
            truncated: stat.size > MAX_PREVIEW_BYTES,
            content: binary ? null : buffer.toString('utf-8'),
            size: stat.size,
            isImage: false,
        };
    }

    private async serveRaw(session: InternalSession, relPath: string, res: ServerResponse): Promise<void> {
        const abs = this.resolveSafe(session, relPath);
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) {
            this.sendJson(res, 404, { error: 'Not found' });
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeFromExt(path.extname(abs)), 'Content-Length': stat.size });
        fsSync.createReadStream(abs).pipe(res);
    }

    private async serveAttachment(session: InternalSession, id: string, res: ServerResponse): Promise<void> {
        const attachment = session.attachments.get(id);
        if (!attachment) {
            this.sendJson(res, 404, { error: 'Attachment not found' });
            return;
        }
        const stat = await fsp.stat(attachment.path);
        res.writeHead(200, { 'Content-Type': attachment.mimeType, 'Content-Length': stat.size });
        fsSync.createReadStream(attachment.path).pipe(res);
    }

    private async saveAttachment(session: InternalSession, body: any): Promise<ChatAttachment> {
        const filename = body?.filename;
        const dataBase64 = body?.dataBase64;
        if (!filename || !dataBase64) {
            throw new TyrError('Missing filename or file data', null, 'Send { filename, mimeType, dataBase64 } to /api/upload.');
        }

        const id = crypto.randomUUID();
        const safeName = String(filename).replace(/[^\w.\-]/g, '_');
        const destPath = path.join(session.tempDir, `${id}-${safeName}`);
        const buffer = Buffer.from(String(dataBase64), 'base64');

        await fsp.writeFile(destPath, buffer);

        const attachment: ChatAttachment = {
            id,
            filename: safeName,
            path: destPath,
            mimeType: body?.mimeType || 'application/octet-stream',
            size: buffer.length,
        };
        session.attachments.set(id, attachment);
        return attachment;
    }

    // --- Messaging --------------------------------------------------------------------------

    private defaultHandler: ChatMessageHandler = () => {
        throw new TyrError('No message handler registered', null, 'Call chat.onMessage(handler) before opening the chat.');
    };

    private async handleMessage(session: InternalSession, body: any): Promise<ChatMessage> {
        const text = typeof body?.text === 'string' ? body.text : '';
        const attachmentIds: string[] = Array.isArray(body?.attachmentIds) ? body.attachmentIds : [];
        const attachments = attachmentIds
            .map((id) => session.attachments.get(id))
            .filter((a): a is ChatAttachment => !!a);

        if (!text.trim() && attachments.length === 0) {
            throw new TyrError('Cannot send an empty message');
        }

        const userMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            text,
            attachments,
            createdAt: Date.now(),
        };
        session.history.push(userMessage);

        await this.emitSafe('message:send', { message: userMessage, history: session.history, dir: session.dir });

        try {
            const handler = this.messageHandler ?? this.defaultHandler;
            const replyText = await handler({
                message: userMessage,
                history: session.history,
                dir: session.dir,
                sessionId: session.id,
                context: this.getContext(session.id),
            });

            const assistantMessage: ChatMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                text: replyText,
                attachments: [],
                createdAt: Date.now(),
            };
            session.history.push(assistantMessage);

            await this.emitSafe('message:response', { message: assistantMessage, history: session.history, dir: session.dir });
            return assistantMessage;
        } catch (e) {
            await this.emitSafe('message:error', { error: e, message: userMessage, dir: session.dir });
            throw e instanceof TyrError ? e : new TyrError('Chat message handler failed', e);
        }
    }

    // --- UI -----------------------------------------------------------------------------------

    private renderPage(session: InternalSession): string {
        const bootstrap = JSON.stringify({
            dir: session.dir,
            splitRatio: session.splitRatio,
            title: session.title,
            priorityCeiling: session.priorityCeiling ?? null,
        }).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${session.title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; font-family: 'Segoe UI', sans-serif; background: #1b1b1b; color: #eee; }
  #app { display: grid; grid-template-columns: var(--chat-w, 40%) 6px 1fr; height: 100vh; }
  #chat-pane, #files-pane { display: flex; flex-direction: column; min-width: 220px; overflow: hidden; }
  #chat-pane { border-right: 1px solid #333; }
  #divider { cursor: col-resize; background: #262626; }
  #divider:hover { background: #4db8ff; }
  header { padding: 12px 16px; border-bottom: 1px solid #333; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 85%; padding: 10px 14px; border-radius: 10px; line-height: 1.45; word-break: break-word; font-size: 14px; }
  .msg.user { align-self: flex-end; background: #2563eb22; border: 1px solid #2563eb55; }
  .msg.assistant { align-self: flex-start; background: #2d2d2d; border: 1px solid #3a3a3a; }
  .msg.error { align-self: flex-start; background: #4d1f1f; border: 1px solid #7a2b2b; color: #ffb4b4; }
  .msg > *:first-child { margin-top: 0; }
  .msg > *:last-child { margin-bottom: 0; }
  .msg p { margin: 0 0 8px 0; }
  .msg h1, .msg h2, .msg h3, .msg h4, .msg h5, .msg h6 { margin: 10px 0 6px 0; line-height: 1.3; }
  .msg ul, .msg ol { margin: 4px 0 8px 22px; padding: 0; }
  .msg li { margin: 2px 0; }
  .msg pre { background: #111; padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
  .msg code { background: #00000055; padding: 1px 4px; border-radius: 4px; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.9em; }
  .msg pre code { background: none; padding: 0; }
  .msg blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #555; color: #aaa; }
  .msg hr { border: none; border-top: 1px solid #444; margin: 10px 0; }
  .msg a { color: #4db8ff; }
  .attachments { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .attachments img { width: 72px; height: 72px; object-fit: cover; border-radius: 6px; border: 1px solid #444; }
  #compose { border-top: 1px solid #333; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  #pending-attachments { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { position: relative; }
  .chip img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid #444; }
  .chip button { position: absolute; top: -6px; right: -6px; background: #c0392b; color: #fff; border: none; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; font-size: 11px; line-height: 1; }
  #compose-row { display: flex; gap: 8px; align-items: flex-end; }
  textarea#msg-input { flex: 1; resize: none; background: #151515; color: #eee; border: 1px solid #333; border-radius: 8px; padding: 10px; font-family: inherit; font-size: 14px; max-height: 140px; min-height: 42px; }
  button { cursor: pointer; border-radius: 8px; border: none; font-weight: 600; padding: 10px 14px; }
  #send-btn { background: #4db8ff; color: #00121f; }
  #send-btn:disabled { opacity: 0.5; cursor: default; }
  #attach-btn { background: #333; color: #eee; }
  #priority-select { display: none; background: #151515; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
  #files-header span:last-child { color: #888; font-weight: 400; font-size: 12px; }
  #tree { flex: 1; overflow-y: auto; padding: 8px; }
  .tree-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; white-space: nowrap; }
  .tree-row:hover { background: #262626; }
  .tree-row.in-context { background: #4db8ff26; border: 1px solid #4db8ff88; }
  .tree-row.in-context:hover { background: #4db8ff3a; }
  .tree-row.in-context::after { content: '📌'; margin-left: 4px; opacity: 0.85; }
  .tree-children { margin-left: 16px; display: none; }
  .tree-children.open { display: block; }
  #preview { border-top: 1px solid #333; max-height: 45%; overflow: auto; padding: 12px; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12.5px; }
  #preview img { max-width: 100%; border-radius: 6px; }
  #preview pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
</style>
</head>
<body>
<div id="app">
  <div id="chat-pane">
    <header><span>💬 ${session.title}</span><select id="priority-select" title="Maximum effort/model tier this chat may ever use"></select></header>
    <div id="messages"></div>
    <div id="compose">
      <div id="pending-attachments"></div>
      <div id="compose-row">
        <button id="attach-btn" type="button" title="Attach image">📎</button>
        <input id="file-input" type="file" accept="image/*" multiple style="display:none">
        <textarea id="msg-input" placeholder="Write a message... (Enter to send, Shift+Enter for newline)"></textarea>
        <button id="send-btn" type="button">Send</button>
      </div>
    </div>
  </div>
  <div id="divider"></div>
  <div id="files-pane">
    <header id="files-header"><span>📂 Files</span><span>${session.dir}</span></header>
    <div id="tree"></div>
    <div id="preview"></div>
  </div>
</div>
<script>
const BOOTSTRAP = ${bootstrap};
(function () {
  const state = { pending: [], treeCache: {}, context: new Set() };

  const app = document.getElementById('app');
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const pendingEl = document.getElementById('pending-attachments');
  const treeEl = document.getElementById('tree');
  const previewEl = document.getElementById('preview');
  const divider = document.getElementById('divider');
  const prioritySelect = document.getElementById('priority-select');

  function applySplit(ratio) {
    app.style.setProperty('--chat-w', (ratio * 100) + '%');
    try { localStorage.setItem('tyr-chat-split', String(ratio)); } catch (e) {}
  }

  let savedSplit = NaN;
  try { savedSplit = parseFloat(localStorage.getItem('tyr-chat-split')); } catch (e) {}
  applySplit(!isNaN(savedSplit) ? savedSplit : BOOTSTRAP.splitRatio);

  let dragging = false;
  divider.addEventListener('mousedown', function () { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const ratio = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth));
    applySplit(ratio);
  });
  window.addEventListener('mouseup', function () { dragging = false; document.body.style.cursor = ''; });

  if (BOOTSTRAP.priorityCeiling) {
    BOOTSTRAP.priorityCeiling.levels.forEach(function (level) {
      const opt = document.createElement('option');
      opt.value = level;
      opt.textContent = level;
      if (level === BOOTSTRAP.priorityCeiling.current) opt.selected = true;
      prioritySelect.appendChild(opt);
    });
    prioritySelect.style.display = 'inline-block';
    prioritySelect.addEventListener('change', function () {
      fetch('/api/priority-ceiling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: prioritySelect.value }),
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Minimal, dependency-free Markdown renderer. The whole input is HTML-escaped FIRST, and every
  // tag below is introduced by this code afterwards — untrusted text (from the model or the user)
  // is never interpreted as raw HTML, only as Markdown syntax on top of already-safe text.
  var BACKTICK = '\\u0060';

  function isSafeUrl(url) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return true;
    return /^(https?|mailto):/i.test(url);
  }

  function renderInline(text) {
    const codeRe = new RegExp(BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK, 'g');
    text = text.replace(codeRe, function (m, code) { return '<code>' + code + '</code>'; });
    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    text = text.replace(/(^|[^\\w])_([^_]+)_(?!\\w)/g, '$1<em>$2</em>');
    text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (m, label, url) {
      const safeUrl = isSafeUrl(url) ? url : '#';
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return text;
  }

  function renderMarkdown(raw) {
    const escaped = escapeHtml(raw || '');
    const lines = escaped.split('\\n');
    const fence = BACKTICK + BACKTICK + BACKTICK;
    const out = [];
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length > 0) {
        out.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>');
        paragraph = [];
      }
    }

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.indexOf(fence) === 0) {
        flushParagraph();
        const lang = line.slice(fence.length).trim().replace(/[^a-zA-Z0-9_-]/g, '');
        const codeLines = [];
        i++;
        while (i < lines.length && lines[i].indexOf(fence) !== 0) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        const langClass = lang ? ' class="language-' + lang + '"' : '';
        out.push('<pre><code' + langClass + '>' + codeLines.join('\\n') + '</code></pre>');
        continue;
      }

      const headerMatch = line.match(/^(#{1,6})\\s+(.*)$/);
      if (headerMatch) {
        flushParagraph();
        const level = headerMatch[1].length;
        out.push('<h' + level + '>' + renderInline(headerMatch[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^(-{3,}|\\*{3,})\\s*$/.test(line)) {
        flushParagraph();
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^&gt;\\s?/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (i < lines.length && /^&gt;\\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^&gt;\\s?/, ''));
          i++;
        }
        out.push('<blockquote><p>' + quoteLines.map(renderInline).join('<br>') + '</p></blockquote>');
        continue;
      }

      if (/^[-*+]\\s+/.test(line)) {
        flushParagraph();
        const items = [];
        while (i < lines.length && /^[-*+]\\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^[-*+]\\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\\d+\\.\\s+/.test(line)) {
        flushParagraph();
        const oitems = [];
        while (i < lines.length && /^\\d+\\.\\s+/.test(lines[i])) {
          oitems.push('<li>' + renderInline(lines[i].replace(/^\\d+\\.\\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }

      if (line.trim() === '') {
        flushParagraph();
        i++;
        continue;
      }

      paragraph.push(line);
      i++;
    }

    flushParagraph();
    return out.join('');
  }

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.role === 'user' ? 'user' : (msg.role === 'error' ? 'error' : 'assistant'));
    div.innerHTML = renderMarkdown(msg.text || '');
    if (msg.attachments && msg.attachments.length) {
      const wrap = document.createElement('div');
      wrap.className = 'attachments';
      msg.attachments.forEach(function (a) {
        const img = document.createElement('img');
        img.src = '/api/attachment?id=' + encodeURIComponent(a.id);
        img.title = a.filename;
        wrap.appendChild(img);
      });
      div.appendChild(wrap);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function loadHistory() {
    fetch('/api/history').then(function (r) { return r.json(); }).then(function (data) {
      messagesEl.innerHTML = '';
      (data.history || []).forEach(renderMessage);
    });
  }

  function renderPending() {
    pendingEl.innerHTML = '';
    state.pending.forEach(function (a) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const img = document.createElement('img');
      img.src = a.url;
      chip.appendChild(img);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '\\u00d7';
      btn.onclick = function () {
        state.pending = state.pending.filter(function (p) { return p.id !== a.id; });
        renderPending();
      };
      chip.appendChild(btn);
      pendingEl.appendChild(chip);
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  attachBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    const files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = '';
    Promise.all(files.map(function (file) {
      return fileToBase64(file).then(function (dataBase64) {
        return fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, dataBase64: dataBase64 }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.attachment) {
            state.pending.push({
              id: data.attachment.id,
              filename: data.attachment.filename,
              url: '/api/attachment?id=' + data.attachment.id,
            });
          }
        });
      });
    })).then(renderPending);
  });

  function sendMessage() {
    const text = input.value.trim();
    if (!text && state.pending.length === 0) return;

    const attachmentIds = state.pending.map(function (p) { return p.id; });
    renderMessage({ role: 'user', text: text, attachments: state.pending.map(function (p) { return { id: p.id, filename: p.filename }; }) });
    input.value = '';
    state.pending = [];
    renderPending();
    sendBtn.disabled = true;

    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, attachmentIds: attachmentIds }),
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, data: data }; });
    }).then(function (result) {
      if (!result.ok) throw new Error((result.data && result.data.error) || 'Request failed');
      renderMessage(result.data.message);
      if (result.data.context) {
        state.context = new Set(result.data.context);
        applyContextHighlight();
      }
    }).catch(function (e) {
      renderMessage({ role: 'error', text: 'Error: ' + e.message, attachments: [] });
    }).then(function () {
      sendBtn.disabled = false;
      input.focus();
    });
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  function folderIcon(isDir) { return isDir ? '\\ud83d\\udcc1' : '\\ud83d\\udcc4'; }

  function fetchChildren(relPath) {
    if (state.treeCache[relPath]) return Promise.resolve(state.treeCache[relPath]);
    return fetch('/api/tree?path=' + encodeURIComponent(relPath)).then(function (r) { return r.json(); }).then(function (data) {
      state.treeCache[relPath] = data.entries || [];
      return state.treeCache[relPath];
    });
  }

  function loadContext() {
    return fetch('/api/context').then(function (r) { return r.json(); }).then(function (data) {
      state.context = new Set(data.files || []);
    });
  }

  function applyContextHighlight() {
    const rows = treeEl.querySelectorAll('.tree-row[data-path]');
    rows.forEach(function (row) {
      row.classList.toggle('in-context', state.context.has(row.getAttribute('data-path')));
    });
  }

  function toggleContext(relPath) {
    fetch('/api/context/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      state.context = new Set(data.files || []);
      applyContextHighlight();
    });
  }

  function buildNode(entry, container) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = entry.path;
    row.textContent = folderIcon(entry.isDir) + ' ' + entry.name;
    if (!entry.isDir && state.context.has(entry.path)) row.classList.add('in-context');
    container.appendChild(row);

    if (entry.isDir) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children';
      container.appendChild(childrenEl);
      let loaded = false;
      row.addEventListener('click', function () {
        const isOpen = childrenEl.classList.toggle('open');
        if (isOpen && !loaded) {
          loaded = true;
          fetchChildren(entry.path).then(function (children) {
            children.forEach(function (child) { buildNode(child, childrenEl); });
          });
        }
      });
    } else {
      row.addEventListener('click', function () { openFile(entry.path); });
      row.addEventListener('dblclick', function (e) {
        e.preventDefault();
        toggleContext(entry.path);
      });
    }
  }

  function loadTree() {
    treeEl.innerHTML = '';
    fetchChildren('').then(function (entries) {
      entries.forEach(function (entry) { buildNode(entry, treeEl); });
    });
  }

  function openFile(relPath) {
    fetch('/api/file?path=' + encodeURIComponent(relPath)).then(function (r) { return r.json(); }).then(function (data) {
      previewEl.innerHTML = '';
      const title = document.createElement('div');
      title.style.marginBottom = '8px';
      title.style.color = '#4db8ff';
      title.textContent = relPath + (data.truncated ? '  (truncated preview)' : '');
      previewEl.appendChild(title);

      if (data.isImage) {
        const img = document.createElement('img');
        img.src = '/api/raw?path=' + encodeURIComponent(relPath);
        previewEl.appendChild(img);
      } else if (data.binary) {
        const p = document.createElement('div');
        p.textContent = 'Binary file (' + data.size + ' bytes) \\u2014 no preview available.';
        previewEl.appendChild(p);
      } else {
        const pre = document.createElement('pre');
        pre.textContent = data.content || '';
        previewEl.appendChild(pre);
      }
    });
  }

  loadHistory();
  loadContext().then(loadTree);
  input.focus();
})();
</script>
</body>
</html>`;
    }
}

export const ChatManagerTests = {};
