import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AIContextManager } from '../../../src/lib/AIContextManager.js';
import { AIVendorManager } from '../../../src/lib/AIVendorManager.js';
import { FileSystemManager } from '../../../src/lib/FileSystemManager.js';
import { ShellManager } from '../../../src/lib/ShellManager.js';
import { GitManager } from '../../../src/lib/GitManager.js';
import { SandboxManager } from '../../../src/lib/SandboxManager.js';
import { Logger } from '../../../src/core/Logger.js';

const mockLogger: Logger = {
    line: () => {},
    log: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
    warn: () => {},
};

function buildManager() {
    const fs = new FileSystemManager(mockLogger);
    const shell = new ShellManager();
    const aiVendor = new AIVendorManager(mockLogger);
    const git = new GitManager(shell, mockLogger);
    const sandbox = new SandboxManager(mockLogger);
    return new AIContextManager(fs, shell, aiVendor, mockLogger, git, sandbox) as any; // `any` to reach private members under test
}

const fakeTokens: any = {
    assertWithinLimit: () => {},
    recordUsage: () => {},
    estimateTokens: (t: string) => Math.ceil((t?.length ?? 0) / 4),
};

describe('AIContextManager — Search/Replace patch engine', () => {
    const ctx = buildManager();

    it('applies an exact match', () => {
        const result = ctx.applySearchReplace('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 100;');
        expect(result.applied).toBe(true);
        expect(result.content).toBe('const a = 100;\nconst b = 2;\n');
    });

    it('falls back to whitespace-tolerant fuzzy matching', () => {
        const original = 'function foo() {\n    return 1;\n}\n';
        // Different indentation than the original — must still match via the fuzzy fallback.
        const search = 'function foo() {\n  return 1;\n}';
        const result = ctx.applySearchReplace(original, search, 'function foo() {\n    return 2;\n}');
        expect(result.applied).toBe(true);
        expect(result.content).toContain('return 2;');
    });

    it('reports no match when the SEARCH text is not present, even fuzzily', () => {
        const result = ctx.applySearchReplace('const a = 1;\n', 'const totally_different = 99;', 'x');
        expect(result.applied).toBe(false);
    });

    it('treats an empty SEARCH block as brand-new file content', () => {
        const result = ctx.applySearchReplace('', '', 'export const x = 1;\n');
        expect(result.applied).toBe(true);
        expect(result.content).toBe('export const x = 1;\n');
    });

    it('parses a single >>>FILE block with one SEARCH/REPLACE edit', () => {
        const text = [
            '>>>FILE: src/foo.ts',
            '<<<<<<< SEARCH',
            'const a = 1;',
            '=======',
            'const a = 2;',
            '>>>>>>> REPLACE',
            '<<<END',
        ].join('\n');

        const blocks = ctx.parsePatchBlocks(text);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].relPath).toBe('src/foo.ts');
        expect(blocks[0].edits).toEqual([{ search: 'const a = 1;', replace: 'const a = 2;' }]);
    });

    it('parses multiple edits within one file and multiple files', () => {
        const text = [
            '>>>FILE: src/foo.ts',
            '<<<<<<< SEARCH',
            'const a = 1;',
            '=======',
            'const a = 2;',
            '>>>>>>> REPLACE',
            '<<<<<<< SEARCH',
            'const b = 1;',
            '=======',
            'const b = 2;',
            '>>>>>>> REPLACE',
            '<<<END',
            '>>>FILE: src/bar.ts',
            '<<<<<<< SEARCH',
            '',
            '=======',
            'export const bar = true;',
            '>>>>>>> REPLACE',
            '<<<END',
        ].join('\n');

        const blocks = ctx.parsePatchBlocks(text);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].edits).toHaveLength(2);
        expect(blocks[1].relPath).toBe('src/bar.ts');
    });

    it('returns no blocks for plain prose with no patch markers', () => {
        expect(ctx.parsePatchBlocks('Sorry, I could not find anything to change.')).toEqual([]);
    });

    it('parses a new-file block even when the model omits the blank line for the empty SEARCH section', () => {
        // Real models (e.g. gpt-5) write "SEARCH\n=======" with no blank line in between for a
        // brand-new file, instead of "SEARCH\n\n=======" — both must parse to an empty search.
        const text = [
            '>>>FILE: math.js',
            '<<<<<<< SEARCH',
            '=======',
            'function add(a, b) {',
            '  return a + b;',
            '}',
            '>>>>>>> REPLACE',
            '<<<END',
        ].join('\n');

        const blocks = ctx.parsePatchBlocks(text);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].relPath).toBe('math.js');
        expect(blocks[0].edits).toEqual([{ search: '', replace: 'function add(a, b) {\n  return a + b;\n}' }]);
    });
});

describe('AIContextManager — Loop Detector', () => {
    it('aborts after the same tool call repeats 3 times in a row', async () => {
        const ctx = buildManager();

        // Every call returns the exact same tool_use request, forcing the detector to trip.
        const completeWithPriority = vi.fn().mockResolvedValue({
            content: '',
            blocks: [{ type: 'tool_use', id: 'call-1', name: 'list_directory', input: { path: '.' } }],
            vendor: 'anthropic',
            model: 'claude-sonnet-5',
            promptTokens: 10,
            completionTokens: 10,
        });
        ctx.ai.completeWithPriority = completeWithPriority;
        ctx.executeAgentTool = vi.fn().mockResolvedValue('(directory listing)');

        const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'go' }];
        const toolCtx = { projectDir: '/tmp', explorationRoot: '/tmp', ignoredDirs: new Set<string>(), seenFiles: new Set<string>() };

        const result = await ctx.runAgentLoop(messages, toolCtx, fakeTokens, { priority: 'mid', maxIterations: 10 });

        expect(result.content).toMatch(/loop detector/i);
        // 3 calls made before the detector trips on the 3rd identical one; no 4th call needed.
        expect(completeWithPriority).toHaveBeenCalledTimes(3);
    });
});

describe('AIContextManager — runCodeAgent diffs and sandbox verification', () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-agent-test-'));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    const patchText = [
        '>>>FILE: math.js',
        '<<<<<<< SEARCH',
        '=======',
        'function add(a, b) { return a + b; }',
        '>>>>>>> REPLACE',
        '<<<END',
    ].join('\n');

    it('returns a valid unified diff for each file changed', async () => {
        const ctx = buildManager();
        ctx.runAgentLoop = vi.fn().mockResolvedValue({
            content: patchText, promptTokens: 1, completionTokens: 1, toolCallsUsed: 0, priorityUsed: 'mid',
        });
        ctx.runValidation = vi.fn().mockResolvedValue({ ran: false, ok: true });
        ctx.sandbox.verify = vi.fn().mockResolvedValue({ ran: false, ok: true });

        const result = await ctx.runCodeAgent(projectDir, [{ role: 'user', content: 'add math.js' }], fakeTokens, { priority: 'mid' });

        expect(result.filesChanged).toEqual(['math.js']);
        expect(result.fileDiffs).toHaveLength(1);
        expect(result.fileDiffs[0].path).toBe('math.js');
        expect(result.fileDiffs[0].diff).toContain('---');
        expect(result.fileDiffs[0].diff).toContain('+++');
        expect(result.fileDiffs[0].diff).toContain('+function add(a, b)');
    });

    it('drives the same self-heal retry/priority-bump cycle as a validation failure when the sandbox check fails', async () => {
        const ctx = buildManager();
        ctx.runAgentLoop = vi.fn().mockResolvedValue({
            content: patchText, promptTokens: 1, completionTokens: 1, toolCallsUsed: 0, priorityUsed: 'mid',
        });
        ctx.runValidation = vi.fn().mockResolvedValue({ ran: false, ok: true });

        const verify = vi
            .fn()
            .mockResolvedValueOnce({ ran: true, ok: false, command: 'npm run test', output: 'expected 2 got 3' })
            .mockResolvedValueOnce({ ran: true, ok: true, command: 'npm run test' });
        ctx.sandbox.verify = verify;

        const bumpPriority = vi.spyOn(ctx.ai, 'bumpPriority');

        const result = await ctx.runCodeAgent(projectDir, [{ role: 'user', content: 'add math.js' }], fakeTokens, { priority: 'mid' });

        expect(verify).toHaveBeenCalledTimes(2);
        expect(bumpPriority).toHaveBeenCalledTimes(1);
        expect(result.sandbox.ok).toBe(true);
        expect(result.priorityUsed).not.toBe('mid');
    });
});

describe('AIContextManager — git_diff tool', () => {
    const toolCtx = { projectDir: '/tmp/project', explorationRoot: '/tmp/project', ignoredDirs: new Set<string>(), seenFiles: new Set<string>() };

    it('dispatches to GitManager and includes both status and diff, read-only', async () => {
        const ctx = buildManager();
        ctx.git.status = vi.fn().mockResolvedValue('M  file.txt');
        ctx.git.diff = vi.fn().mockResolvedValue('+added line');

        const output = await ctx.executeAgentTool(toolCtx, 'git_diff', {});

        expect(output).toContain('M  file.txt');
        expect(output).toContain('+added line');
        expect(ctx.git.status).toHaveBeenCalledWith('/tmp/project');
        expect(ctx.git.diff).toHaveBeenCalledWith('/tmp/project', { staged: false });
    });

    it('passes staged:true through to GitManager.diff when requested', async () => {
        const ctx = buildManager();
        ctx.git.status = vi.fn().mockResolvedValue('(clean)');
        ctx.git.diff = vi.fn().mockResolvedValue('(no differences)');

        await ctx.executeAgentTool(toolCtx, 'git_diff', { staged: true });

        expect(ctx.git.diff).toHaveBeenCalledWith('/tmp/project', { staged: true });
    });
});
