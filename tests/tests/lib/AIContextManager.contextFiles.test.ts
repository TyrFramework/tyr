import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

/**
 * Layout under a temp root:
 *
 * grandparent/
 *   AGENTS.md                    <- beyond the repo root, must NOT be found
 *   repo/                        <- .git lives here (repo root)
 *     AGENTS.md                  <- ancestor of `app`, must be found
 *     app/                       <- search target
 *       CLAUDE.md                <- distance 0
 *       subA/
 *         README.md              <- inward, distance 1, must be found
 *         subA2/
 *           AGENTS.md            <- inward, distance 2, must be found
 *       subB/
 *         package.json           <- package boundary starts here
 *         AGENTS.md              <- AT the boundary, must still be found
 *         inner/
 *           AGENTS.md            <- PAST the boundary, must NOT be found
 */
describe('AIContextManager — bidirectional context file search', () => {
    let root: string;
    let appDir: string;
    let ctx: AIContextManager;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-context-search-'));

        const grandparent = root;
        const repo = path.join(grandparent, 'repo');
        appDir = path.join(repo, 'app');
        const subA = path.join(appDir, 'subA');
        const subA2 = path.join(subA, 'subA2');
        const subB = path.join(appDir, 'subB');
        const inner = path.join(subB, 'inner');

        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.mkdirSync(subA2, { recursive: true });
        fs.mkdirSync(inner, { recursive: true });

        fs.writeFileSync(path.join(grandparent, 'AGENTS.md'), 'grandparent guidelines');
        fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'repo root guidelines');
        fs.writeFileSync(path.join(appDir, 'CLAUDE.md'), 'app guidelines');
        fs.writeFileSync(path.join(subA, 'README.md'), 'subA readme');
        fs.writeFileSync(path.join(subA2, 'AGENTS.md'), 'subA2 guidelines');
        fs.writeFileSync(path.join(subB, 'package.json'), '{"name":"subB"}');
        fs.writeFileSync(path.join(subB, 'AGENTS.md'), 'subB guidelines (at the boundary)');
        fs.writeFileSync(path.join(inner, 'AGENTS.md'), 'inner guidelines (past the boundary)');

        ctx = new AIContextManager(
            new FileSystemManager(mockLogger),
            new ShellManager(),
            new AIVendorManager(mockLogger),
            mockLogger,
            new GitManager(new ShellManager(), mockLogger),
            new SandboxManager(mockLogger)
        );
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('finds the file in the target directory itself', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).toContain(path.join(appDir, 'CLAUDE.md'));
    });

    it('finds an ancestor file up to the repo root', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).toContain(path.join(appDir, '..', 'AGENTS.md'));
    });

    it('does not climb past the repo root (.git boundary)', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).not.toContain(path.join(appDir, '..', '..', 'AGENTS.md'));
    });

    it('finds files in subdirectories (inward search)', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).toContain(path.join(appDir, 'subA', 'README.md'));
        expect(found).toContain(path.join(appDir, 'subA', 'subA2', 'AGENTS.md'));
    });

    it('includes a context file exactly at a nested package boundary', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).toContain(path.join(appDir, 'subB', 'AGENTS.md'));
    });

    it('excludes context files past a nested package boundary', async () => {
        const found = await ctx.findContextFiles(appDir);
        expect(found).not.toContain(path.join(appDir, 'subB', 'inner', 'AGENTS.md'));
    });

    it('labels guideline blocks with a path relative to the target, not just the basename', async () => {
        const blocks = await ctx.readGuidelines(appDir);
        const names = blocks.map(b => b.fileName);
        expect(names).toContain('CLAUDE.md');
        expect(names).toContain(path.join('..', 'AGENTS.md'));
        expect(names).toContain(path.join('subA', 'README.md'));
    });
});
