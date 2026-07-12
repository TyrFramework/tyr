import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';

import config from '../../../src/core/sys/config.js';
import { FileSystemManager } from '../../../src/lib/FileSystemManager.js';
import { ShellManager } from '../../../src/lib/ShellManager.js';
import { Logger } from '../../../src/core/Logger.js';
import type { TyrContext } from '../../../src/core/Kernel.js';

const mockLogger: Logger = {
    line: () => {},
    log: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
    warn: () => {},
} as any;

// config() reads homedir() itself (not context.userRoot), so these tests point
// HOME/USERPROFILE at a disposable temp dir to keep them isolated from the real
// user's ~/.tyr. os.homedir() reads USERPROFILE (not HOME) on Windows, so both
// must be overridden or these tests silently mutate the real home directory.
describe('config (tyr --config)', () => {
    let homeDir: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;
    let context: TyrContext;

    beforeEach(() => {
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-config-home-'));
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;

        context = {
            frameworkRoot: '/mock/root',
            userRoot: path.join(homeDir, '.tyr'),
            logger: mockLogger,
            fs: new FileSystemManager(mockLogger),
            shell: new ShellManager(),
            run: async () => {},
            task: async (_: string, action: () => any) => action(),
            fail: () => { throw new Error('fail() called'); },
        } as any;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
        fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it('creates an empty imported_modules.yaml on a fresh install', async () => {
        await config(context)([]);

        const importedModulesPath = path.join(homeDir, '.tyr', 'imported_modules.yaml');
        expect(fs.existsSync(importedModulesPath)).toBe(true);
        expect(fs.readFileSync(importedModulesPath, 'utf-8')).toBe('modules: {}\n');
    }, 30000);

    it('backfills imported_modules.yaml when cloning a repo that predates the feature', async () => {
        // Set up a bare "remote" and a working clone that already has map.yml
        // (an established ~/.tyr repo) but no imported_modules.yaml, mirroring
        // installs created before this feature existed.
        const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-config-remote-'));
        await execa('git', ['init', '--bare', '-b', 'main'], { cwd: remoteDir });

        const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-config-seed-'));
        await execa('git', ['clone', remoteDir, seedDir]);
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: seedDir });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
        fs.writeFileSync(path.join(seedDir, 'map.yml'), 'commands: {}\n');
        fs.mkdirSync(path.join(seedDir, 'commands'), { recursive: true });
        fs.writeFileSync(path.join(seedDir, 'commands', '.gitkeep'), '');
        await execa('git', ['add', '.'], { cwd: seedDir });
        await execa('git', ['commit', '-m', 'pre-existing config'], { cwd: seedDir });
        await execa('git', ['push', 'origin', 'main'], { cwd: seedDir });

        await config(context)(['--repo', remoteDir]);

        const importedModulesPath = path.join(homeDir, '.tyr', 'imported_modules.yaml');
        expect(fs.existsSync(importedModulesPath)).toBe(true);
        expect(fs.readFileSync(importedModulesPath, 'utf-8')).toBe('modules: {}\n');

        fs.rmSync(remoteDir, { recursive: true, force: true });
        fs.rmSync(seedDir, { recursive: true, force: true });
    }, 30000);
});
