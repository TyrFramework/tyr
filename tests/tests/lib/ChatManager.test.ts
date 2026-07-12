import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';

import { ChatManager, ChatSession } from '../../../src/lib/ChatManager.js';
import { FileSystemManager } from '../../../src/lib/FileSystemManager.js';
import { Logger } from '../../../src/core/Logger.js';

const mockLogger: Logger = {
    line: () => {},
    log: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
    warn: () => {},
};

const api = axios.create({ validateStatus: () => true });

describe('ChatManager', () => {
    let workDir: string;
    let chat: ChatManager;
    let session: ChatSession;

    beforeEach(async () => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-chat-test-'));
        fs.writeFileSync(path.join(workDir, 'hello.txt'), 'Hello Tyr!');
        fs.mkdirSync(path.join(workDir, 'sub'));
        fs.writeFileSync(path.join(workDir, 'sub', 'nested.txt'), 'Nested file');

        chat = new ChatManager(new FileSystemManager(mockLogger), mockLogger);
        session = await chat.open(workDir, { port: 0, splitRatio: 0.4 });
    });

    afterEach(async () => {
        await session.stop();
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('serves the chat page at the session URL', async () => {
        const res = await api.get(session.url);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.data).toContain('id="messages"');
        expect(res.data).toContain('id="tree"');
    });

    it('creates a temp directory for attachments and removes it on stop()', async () => {
        expect(fs.existsSync(session.tempDir)).toBe(true);
        await session.stop();
        expect(fs.existsSync(session.tempDir)).toBe(false);
        // re-open for the afterEach hook, which also calls stop()
        session = await chat.open(workDir, { port: 0 });
    });

    it('lists directory entries via /api/tree', async () => {
        const res = await api.get(`${session.url}/api/tree`, { params: { path: '' } });
        expect(res.status).toBe(200);
        const names = res.data.entries.map((e: any) => e.name);
        expect(names).toEqual(expect.arrayContaining(['hello.txt', 'sub']));
    });

    it('reads a file via /api/file', async () => {
        const res = await api.get(`${session.url}/api/file`, { params: { path: 'hello.txt' } });
        expect(res.status).toBe(200);
        expect(res.data.binary).toBe(false);
        expect(res.data.content).toBe('Hello Tyr!');
    });

    it('rejects path traversal attempts', async () => {
        const res = await api.get(`${session.url}/api/file`, { params: { path: '../outside.txt' } });
        expect(res.status).toBe(400);
        expect(res.data.error).toMatch(/escapes/i);
    });

    it('uploads an image attachment and serves it back', async () => {
        const dataBase64 = Buffer.from('fake-png-bytes').toString('base64');
        const uploadRes = await api.post(`${session.url}/api/upload`, {
            filename: 'shot.png',
            mimeType: 'image/png',
            dataBase64,
        });
        expect(uploadRes.status).toBe(200);
        const attachment = uploadRes.data.attachment;
        expect(attachment.filename).toBe('shot.png');
        expect(fs.existsSync(attachment.path)).toBe(true);

        const fetched = await api.get(`${session.url}/api/attachment`, {
            params: { id: attachment.id },
            responseType: 'arraybuffer',
        });
        expect(fetched.status).toBe(200);
        expect(Buffer.from(fetched.data).toString()).toBe('fake-png-bytes');
    });

    it('fails a message with no handler registered', async () => {
        const res = await api.post(`${session.url}/api/message`, { text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.data.error).toMatch(/no message handler/i);
    });

    it('runs the onMessage handler and fires send/response hooks in order', async () => {
        const events: string[] = [];
        chat.onMessage(async ({ message }) => {
            events.push('handler');
            return `echo: ${message.text}`;
        });
        chat.on('message:send', () => events.push('send'));
        chat.on('message:response', () => events.push('response'));

        const res = await api.post(`${session.url}/api/message`, { text: 'ping' });

        expect(res.status).toBe(200);
        expect(res.data.message.role).toBe('assistant');
        expect(res.data.message.text).toBe('echo: ping');
        expect(events).toEqual(['send', 'handler', 'response']);
    });

    it('fires message:error and surfaces the failure when the handler throws', async () => {
        let captured: any = null;
        chat.onMessage(async () => {
            throw new Error('boom');
        });
        chat.on('message:error', (payload: any) => { captured = payload; });

        const res = await api.post(`${session.url}/api/message`, { text: 'trigger' });

        expect(res.status).toBe(400);
        expect(captured).not.toBeNull();
        expect(captured.error.message).toBe('boom');
    });

    it('starts with an empty context and reports it via /api/context', async () => {
        const res = await api.get(`${session.url}/api/context`);
        expect(res.status).toBe(200);
        expect(res.data.files).toEqual([]);
    });

    it('adds valid files to the context and skips missing/invalid ones', async () => {
        const added = await chat.addToContext(session.id, ['hello.txt', 'sub/nested.txt', 'nope.txt', 'sub']);
        expect(added).toEqual(['hello.txt', 'sub/nested.txt']);
        expect(chat.getContext(session.id)).toEqual(['hello.txt', 'sub/nested.txt']);
    });

    it('ignores context paths that try to escape the session directory', async () => {
        const added = await chat.addToContext(session.id, ['../outside.txt']);
        expect(added).toEqual([]);
        expect(chat.getContext(session.id)).toEqual([]);
    });

    it('toggles a file in and out of context via /api/context/toggle', async () => {
        const addRes = await api.post(`${session.url}/api/context/toggle`, { path: 'hello.txt' });
        expect(addRes.status).toBe(200);
        expect(addRes.data.added).toBe(true);
        expect(addRes.data.files).toEqual(['hello.txt']);

        const removeRes = await api.post(`${session.url}/api/context/toggle`, { path: 'hello.txt' });
        expect(removeRes.status).toBe(200);
        expect(removeRes.data.added).toBe(false);
        expect(removeRes.data.files).toEqual([]);
    });

    it('fires context:change when the context set is mutated', async () => {
        const events: any[] = [];
        chat.on('context:change', (payload: any) => events.push(payload));

        await chat.addToContext(session.id, ['hello.txt']);
        await chat.removeFromContext(session.id, 'hello.txt');

        expect(events).toHaveLength(2);
        expect(events[0].files).toEqual(['hello.txt']);
        expect(events[1].files).toEqual([]);
    });

    it('passes sessionId and the current context snapshot to the onMessage handler, and returns it from /api/message', async () => {
        await chat.addToContext(session.id, ['hello.txt']);

        let seenContext: string[] = [];
        let seenSessionId = '';
        chat.onMessage(async ({ context, sessionId }) => {
            seenContext = context;
            seenSessionId = sessionId;
            return 'ok';
        });

        const res = await api.post(`${session.url}/api/message`, { text: 'hi' });

        expect(res.status).toBe(200);
        expect(seenSessionId).toBe(session.id);
        expect(seenContext).toEqual(['hello.txt']);
        expect(res.data.context).toEqual(['hello.txt']);
    });

    it('includes dir and history in the chat:close payload', async () => {
        chat.onMessage(async () => 'reply');
        await api.post(`${session.url}/api/message`, { text: 'ping' });

        let captured: any = null;
        chat.on('chat:close', (payload: any) => { captured = payload; });

        await session.stop();
        session = await chat.open(workDir, { port: 0 }); // re-open for the afterEach hook's own stop()

        expect(captured).not.toBeNull();
        expect(captured.dir).toBe(workDir);
        expect(captured.history).toHaveLength(2);
        expect(captured.history[0].text).toBe('ping');
    });
});

describe('ChatManager — priority ceiling', () => {
    let workDir: string;
    let chat: ChatManager;
    let session: ChatSession;

    beforeEach(async () => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-chat-test-'));
        chat = new ChatManager(new FileSystemManager(mockLogger), mockLogger);
        session = await chat.open(workDir, {
            port: 0,
            priorityCeiling: { levels: ['low', 'mid', 'high'], initial: 'mid' },
        });
    });

    afterEach(async () => {
        await session.stop();
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('renders the levels and current value in the served page bootstrap', async () => {
        const res = await api.get(session.url);
        expect(res.data).toContain('"priorityCeiling":{"levels":["low","mid","high"],"current":"mid"}');
    });

    it('updates the ceiling and fires priority:change on a valid value', async () => {
        let captured: any = null;
        chat.on('priority:change', (payload: any) => { captured = payload; });

        const res = await api.post(`${session.url}/api/priority-ceiling`, { value: 'high' });

        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true, value: 'high' });
        expect(captured).toEqual({ sessionId: session.id, dir: workDir, value: 'high' });
    });

    it('rejects a value outside the configured levels', async () => {
        const res = await api.post(`${session.url}/api/priority-ceiling`, { value: 'very-high' });
        expect(res.status).toBe(400);
        expect(res.data.error).toMatch(/invalid/i);
    });
});

describe('ChatManager — no priority ceiling configured', () => {
    it('omits priorityCeiling from the bootstrap when the option is not passed', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-chat-test-'));
        const chat = new ChatManager(new FileSystemManager(mockLogger), mockLogger);
        const session = await chat.open(workDir, { port: 0 });

        const res = await api.get(session.url);
        expect(res.data).toContain('"priorityCeiling":null');

        await session.stop();
        fs.rmSync(workDir, { recursive: true, force: true });
    });
});
