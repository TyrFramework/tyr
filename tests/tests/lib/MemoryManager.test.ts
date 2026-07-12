import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MemoryManager, MemoryConversationEntry } from '../../../src/lib/MemoryManager.js';
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

// MemoryManager always writes under ~/.tyr/.tyr-mem — point HOME at a disposable temp dir so
// these tests never touch the real user's memory store.
describe('MemoryManager', () => {
    let homeDir: string;
    let originalHome: string | undefined;
    let memory: MemoryManager;
    let projectA: string;
    let projectB: string;

    beforeEach(() => {
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-memory-home-'));
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;

        memory = new MemoryManager(new FileSystemManager(mockLogger), mockLogger);
        projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-memory-projA-'));
        projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-memory-projB-'));
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(projectA, { recursive: true, force: true });
        fs.rmSync(projectB, { recursive: true, force: true });
    });

    function entry(overrides: Partial<MemoryConversationEntry> = {}): MemoryConversationEntry {
        return {
            command: 'ai:chat',
            history: [
                { role: 'user', text: 'Add a greet function to hello.js that returns Hello, name!' },
                { role: 'assistant', text: 'Created hello.js with an exported greet(name) function.' },
            ],
            filesChanged: ['hello.js'],
            ...overrides,
        };
    }

    it('writes a valid frontmatter + summary + timeline markdown file', async () => {
        const filePath = await memory.recordConversation(projectA, entry());
        expect(fs.existsSync(filePath)).toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toMatch(/^---\n/);
        expect(content).toContain('command: ai:chat');
        expect(content).toContain('- hello.js');
        expect(content).toContain('## Summary');
        expect(content).toContain('## Timeline');
        expect(content).toContain('- user: Add a greet function');
    });

    it('produces the same project slug for the same path across calls, and a different one for a different path', async () => {
        const pathA = await memory.recordConversation(projectA, entry());
        const pathA2 = await memory.recordConversation(projectA, entry());
        const pathB = await memory.recordConversation(projectB, entry());

        expect(path.dirname(pathA)).toBe(path.dirname(pathA2));
        expect(path.dirname(pathA)).not.toBe(path.dirname(pathB));
    });

    it('includes filesChanged basenames as topics unconditionally', async () => {
        const filePath = await memory.recordConversation(projectA, entry({ filesChanged: ['src/utils/mathHelpers.ts'] }));
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('mathhelpers');
    });

    it('findRelevant returns nothing below the relevance threshold', async () => {
        await memory.recordConversation(projectA, entry());
        const matches = await memory.findRelevant(projectA, 'completely unrelated database migration topic');
        expect(matches).toEqual([]);
    });

    it('findRelevant returns a match when the task text overlaps the recorded topics', async () => {
        await memory.recordConversation(projectA, entry());
        const matches = await memory.findRelevant(projectA, 'can you look at the greet function in hello.js again');
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].command).toBe('ai:chat');
    });

    it('never returns matches from a different project', async () => {
        await memory.recordConversation(projectA, entry());
        const matches = await memory.findRelevant(projectB, 'the greet function in hello.js');
        expect(matches).toEqual([]);
    });

    it('getContextMessage returns null when nothing relevant was found', async () => {
        const message = await memory.getContextMessage(projectA, 'anything at all');
        expect(message).toBeNull();
    });

    it('getContextMessage returns a system message when something relevant was found', async () => {
        await memory.recordConversation(projectA, entry());
        const message = await memory.getContextMessage(projectA, 'tell me about the greet function in hello.js');
        expect(message).not.toBeNull();
        expect(message!.role).toBe('system');
        expect(String(message!.content)).toContain('hello.js');
    });
});
