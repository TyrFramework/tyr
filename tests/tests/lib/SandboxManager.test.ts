import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function writePackageJson(dir: string, scripts: Record<string, string>): void {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }));
}

describe('SandboxManager', () => {
    let projectDir: string;
    let sandbox: SandboxManager;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-sandbox-test-'));
        sandbox = new SandboxManager(mockLogger);
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('returns ran:false when there is no package.json', async () => {
        const result = await sandbox.verify(projectDir);
        expect(result).toEqual({ ran: false, ok: true });
    });

    it('returns ran:false for the default npm placeholder test script', async () => {
        writePackageJson(projectDir, { test: 'echo "Error: no test specified" && exit 1' });
        const result = await sandbox.verify(projectDir);
        expect(result).toEqual({ ran: false, ok: true });
    });

    it('reports ok:true when the test script exits 0', async () => {
        writePackageJson(projectDir, { test: 'node -e "process.exit(0)"' });
        const result = await sandbox.verify(projectDir);
        expect(result.ran).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.command).toBe('npm run test');
    }, 15000);

    it('reports ok:false with captured output when the test script exits non-zero', async () => {
        writePackageJson(projectDir, { test: 'node -e "console.error(\'boom\'); process.exit(1)"' });
        const result = await sandbox.verify(projectDir);
        expect(result.ran).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.output).toContain('boom');
    }, 15000);

    it('falls back to the build script when there is no usable test script', async () => {
        writePackageJson(projectDir, { build: 'node -e "process.exit(0)"' });
        const result = await sandbox.verify(projectDir);
        expect(result.ran).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.command).toBe('npm run build');
    }, 15000);

    it('symlinks node_modules so a dependency actually resolves in the sandbox copy', async () => {
        const nodeModules = path.join(projectDir, 'node_modules', 'dummy-pkg');
        fs.mkdirSync(nodeModules, { recursive: true });
        fs.writeFileSync(path.join(nodeModules, 'index.js'), 'module.exports = 42;');
        fs.writeFileSync(path.join(nodeModules, 'package.json'), JSON.stringify({ name: 'dummy-pkg', main: 'index.js' }));
        writePackageJson(projectDir, { test: 'node -e "if (require(\'dummy-pkg\') !== 42) process.exit(1)"' });

        const result = await sandbox.verify(projectDir);
        expect(result.ok).toBe(true);
    }, 15000);

    it('cleans up the temp directory after a successful run', async () => {
        writePackageJson(projectDir, { test: 'node -e "process.exit(0)"' });
        const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tyr-sandbox-'));
        await sandbox.verify(projectDir);
        const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tyr-sandbox-'));
        expect(after.length).toBe(before.length);
    }, 15000);

    it('cleans up the temp directory after a failing run', async () => {
        writePackageJson(projectDir, { test: 'node -e "process.exit(1)"' });
        const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tyr-sandbox-'));
        await sandbox.verify(projectDir);
        const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tyr-sandbox-'));
        expect(after.length).toBe(before.length);
    }, 15000);
});
