import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';

import { GitManager } from '../../../src/lib/GitManager.js';
import { ShellManager } from '../../../src/lib/ShellManager.js';
import { Logger } from '../../../src/core/Logger.js';

const mockLogger: Logger = {
    line: () => {},
    log: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
    warn: () => {},
};

describe('GitManager — read-only status/diff', () => {
    let repoDir: string;
    let git: GitManager;

    beforeEach(async () => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-git-test-'));
        git = new GitManager(new ShellManager(), mockLogger);

        await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'file.txt'), 'line one\n');
        await execa('git', ['add', '.'], { cwd: repoDir });
        await execa('git', ['commit', '-m', 'initial'], { cwd: repoDir });
    });

    afterEach(() => {
        fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it('reports a clean status right after a commit', async () => {
        const status = await git.status(repoDir);
        expect(status).toMatch(/clean/i);
    });

    it('reports modified files in status --porcelain format', async () => {
        fs.writeFileSync(path.join(repoDir, 'file.txt'), 'line one\nline two\n');
        const status = await git.status(repoDir);
        expect(status).toContain('M ');
        expect(status).toContain('file.txt');
    });

    it('shows the unstaged diff for a modified file', async () => {
        fs.writeFileSync(path.join(repoDir, 'file.txt'), 'line one\nline two\n');
        const diff = await git.diff(repoDir);
        expect(diff).toContain('+line two');
        expect(diff).toContain('file.txt');
    });

    it('reports no differences when nothing changed', async () => {
        const diff = await git.diff(repoDir);
        expect(diff).toMatch(/no differences/i);
    });

    it('shows the staged diff separately when staged: true is passed', async () => {
        fs.writeFileSync(path.join(repoDir, 'file.txt'), 'line one\nline two\n');
        await execa('git', ['add', '.'], { cwd: repoDir });

        const unstagedDiff = await git.diff(repoDir);
        const stagedDiff = await git.diff(repoDir, { staged: true });
        expect(unstagedDiff).toMatch(/no differences/i);
        expect(stagedDiff).toContain('+line two');
    });

    it('returns a friendly string instead of throwing for a non-git directory', async () => {
        const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-not-a-repo-'));
        try {
            const status = await git.status(nonRepoDir);
            const diff = await git.diff(nonRepoDir);
            expect(status).toMatch(/not a git repository|failed/i);
            expect(diff).toMatch(/failed/i);
        } finally {
            fs.rmSync(nonRepoDir, { recursive: true, force: true });
        }
    });
});
