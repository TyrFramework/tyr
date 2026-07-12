import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { execa } from 'execa';

import { syncModules, addModule, removeModule, generateManifest } from '../../../src/core/sys/modules.js';
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

describe('modules (imported_modules.yaml sync)', () => {
    let userRoot: string;
    let webGet: ReturnType<typeof vi.fn>;
    let context: TyrContext;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-modules-'));
        fs.mkdirSync(path.join(userRoot, 'commands'), { recursive: true });
        fs.writeFileSync(path.join(userRoot, 'map.yml'), 'commands: {}\n');

        webGet = vi.fn();

        context = {
            frameworkRoot: '/mock/root',
            userRoot,
            logger: mockLogger,
            fs: new FileSystemManager(mockLogger),
            web: { get: webGet },
            run: vi.fn(),
            task: vi.fn(),
            fail: vi.fn(),
        } as any;
    });

    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    function writeImportedModules(modules: Record<string, string>) {
        fs.writeFileSync(
            path.join(userRoot, 'imported_modules.yaml'),
            yaml.dump({ modules }),
        );
    }

    function readMap(): Record<string, string> {
        const raw = fs.readFileSync(path.join(userRoot, 'map.yml'), 'utf-8');
        return (yaml.load(raw) as any).commands ?? {};
    }

    function readLock(): Record<string, any> {
        const lockPath = path.join(userRoot, 'imported_modules.lock.yml');
        if (!fs.existsSync(lockPath)) return {};
        const raw = fs.readFileSync(lockPath, 'utf-8');
        return (yaml.load(raw) as any).commands ?? {};
    }

    it('does nothing when there is no imported_modules.yaml', async () => {
        const summary = await syncModules(context);
        expect(summary.installed).toEqual([]);
        expect(fs.existsSync(path.join(userRoot, 'imported_modules.lock.yml'))).toBe(false);
    });

    it('installs a command that is missing locally', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'export default () => async () => {};';
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context);

        expect(summary.installed).toEqual(['foo']);
        expect(readMap().foo).toBe('./commands/foo.tyr.ts');
        expect(readLock().foo).toMatchObject({ module: 'moduleA' });
        expect(fs.readFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'utf-8'))
            .toContain('export default');
    });

    it('installs a namespaced command name (db:migrate) using a filesystem-safe file name', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { 'db:migrate': 'https://raw.githubusercontent.com/org/repo/migrate.tyr.ts' };
            if (url.includes('migrate.tyr.ts')) return 'export default () => async () => {};';
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context);

        expect(summary.installed).toEqual(['db:migrate']);
        // The map/lock keys keep the real, colon-containing name...
        expect(readMap()['db:migrate']).toBe('./commands/db-migrate.tyr.ts');
        expect(readLock()['db:migrate']).toMatchObject({ module: 'moduleA' });
        // ...but the file on disk is sanitized, since ':' isn't a valid Windows filename character.
        expect(fs.existsSync(path.join(userRoot, 'commands', 'db-migrate.tyr.ts'))).toBe(true);
    });

    it('rejects manifests with malformed namespaced command names', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { ':bad': 'https://raw.githubusercontent.com/org/repo/bad.tyr.ts' };
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context);

        expect(summary.failed.length).toBe(1);
        expect(readMap()[':bad']).toBeUndefined();
    });

    it('does not re-download an already-installed managed command without --force', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'v1';
            throw new Error(`unexpected url: ${url}`);
        });

        await syncModules(context);
        webGet.mockClear();

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'v2 (should not be fetched)';
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context);

        expect(summary.skipped).toEqual(['foo']);
        expect(fs.readFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'utf-8')).toBe('v1');
    });

    it('re-downloads a managed command when --force is used', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'v1';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context);

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'v2';
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context, { force: true });

        expect(summary.updated).toEqual(['foo']);
        expect(fs.readFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'utf-8')).toBe('v2');
    });

    it('never touches a pre-existing command that is not managed by an import', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));
        fs.writeFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'hand-written');

        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'imported version';
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context, { force: true });

        expect(summary.skipped).toEqual(['foo']);
        expect(fs.readFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'utf-8')).toBe('hand-written');
        expect(readLock().foo).toBeUndefined();
    });

    it('resolves same-name collisions across modules with "last one wins"', async () => {
        writeImportedModules({
            moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json',
            moduleB: 'https://raw.githubusercontent.com/org/repo/manifestB.json',
        });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo-a.tyr.ts' };
            if (url.includes('manifestB')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo-b.tyr.ts' };
            if (url.includes('foo-a.tyr.ts')) return 'from module A';
            if (url.includes('foo-b.tyr.ts')) return 'from module B';
            throw new Error(`unexpected url: ${url}`);
        });

        await syncModules(context);

        expect(fs.readFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'utf-8')).toBe('from module B');
        expect(readLock().foo).toMatchObject({ module: 'moduleB' });
    });

    it('rejects manifests with non-https URLs', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'http://insecure.example.com/foo.tyr.ts' };
            throw new Error(`unexpected url: ${url}`);
        });

        const summary = await syncModules(context);

        expect(summary.failed.length).toBe(1);
        expect(readMap().foo).toBeUndefined();
    });

    function readLockEnv(): Record<string, any> {
        const lockPath = path.join(userRoot, 'imported_modules.lock.yml');
        if (!fs.existsSync(lockPath)) return {};
        const raw = fs.readFileSync(lockPath, 'utf-8');
        return (yaml.load(raw) as any).env ?? {};
    }

    it('downloads the $env reference as .env.<module>.example', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) {
                return {
                    foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts',
                    $env: 'https://raw.githubusercontent.com/org/repo/.env.example',
                };
            }
            if (url.includes('foo.tyr.ts')) return 'export default () => async () => {};';
            if (url.includes('.env.example')) return 'API_KEY=\n';
            throw new Error(`unexpected url: ${url}`);
        });

        await syncModules(context);

        expect(fs.readFileSync(path.join(userRoot, '.env.moduleA.example'), 'utf-8')).toBe('API_KEY=\n');
        expect(readLockEnv().moduleA).toMatchObject({ file: '.env.moduleA.example' });
    });

    it('sanitizes a namespaced module name in the .env filename', async () => {
        writeImportedModules({ 'org:moduleA': 'https://raw.githubusercontent.com/org/repo/manifestA.json' });

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'API_KEY=\n';
            throw new Error(`unexpected url: ${url}`);
        });

        await syncModules(context);

        expect(fs.existsSync(path.join(userRoot, '.env.org-moduleA.example'))).toBe(true);
        expect(readLockEnv()['org:moduleA']).toMatchObject({ file: '.env.org-moduleA.example' });
    });

    it('does not re-download an already-installed .env.example without --force', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'V1=\n';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context);

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'V2=\n';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context);

        expect(fs.readFileSync(path.join(userRoot, '.env.moduleA.example'), 'utf-8')).toBe('V1=\n');
    });

    it('re-downloads .env.example when --force is used', async () => {
        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'V1=\n';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context);

        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'V2=\n';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context, { force: true });

        expect(fs.readFileSync(path.join(userRoot, '.env.moduleA.example'), 'utf-8')).toBe('V2=\n');
    });

    it('never overwrites an unrelated pre-existing file with the same .env.<module>.example name', async () => {
        fs.writeFileSync(path.join(userRoot, '.env.moduleA.example'), 'hand-written');

        writeImportedModules({ moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json' });
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { $env: 'https://raw.githubusercontent.com/org/repo/.env.example' };
            if (url.includes('.env.example')) return 'imported';
            throw new Error(`unexpected url: ${url}`);
        });

        await syncModules(context, { force: true });

        expect(fs.readFileSync(path.join(userRoot, '.env.moduleA.example'), 'utf-8')).toBe('hand-written');
        expect(readLockEnv().moduleA).toBeUndefined();
    });
});

describe('addModule', () => {
    let userRoot: string;
    let webGet: ReturnType<typeof vi.fn>;
    let context: TyrContext;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-modules-add-'));
        fs.mkdirSync(path.join(userRoot, 'commands'), { recursive: true });
        fs.writeFileSync(path.join(userRoot, 'map.yml'), 'commands: {}\n');

        webGet = vi.fn();

        context = {
            frameworkRoot: '/mock/root',
            userRoot,
            logger: mockLogger,
            fs: new FileSystemManager(mockLogger),
            web: { get: webGet },
            run: vi.fn(),
            task: vi.fn(),
            fail: vi.fn(),
        } as any;
    });

    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    it('registers the manifest and immediately syncs missing commands', async () => {
        const manifestUrl = 'https://raw.githubusercontent.com/org/repo/manifestA.json';

        webGet.mockImplementation(async (url: string) => {
            if (url === manifestUrl) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('foo.tyr.ts')) return 'export default () => async () => {};';
            throw new Error(`unexpected url: ${url}`);
        });

        await addModule(context, manifestUrl, 'my-module');

        const modulesRaw = fs.readFileSync(path.join(userRoot, 'imported_modules.yaml'), 'utf-8');
        expect((yaml.load(modulesRaw) as any).modules['my-module']).toBe(manifestUrl);

        const mapRaw = fs.readFileSync(path.join(userRoot, 'map.yml'), 'utf-8');
        expect((yaml.load(mapRaw) as any).commands.foo).toBe('./commands/foo.tyr.ts');
    });

    it('defaults the module name to the repo name for a raw.githubusercontent.com URL when none is given', async () => {
        const manifestUrl = 'https://raw.githubusercontent.com/someuser/tyr-modules/main/manifest.json';

        webGet.mockImplementation(async (url: string) => {
            if (url === manifestUrl) return {};
            throw new Error(`unexpected url: ${url}`);
        });

        await addModule(context, manifestUrl);

        const modulesRaw = fs.readFileSync(path.join(userRoot, 'imported_modules.yaml'), 'utf-8');
        expect((yaml.load(modulesRaw) as any).modules['tyr-modules']).toBe(manifestUrl);
    });

    it('falls back to a slug of the file name when the host is not raw.githubusercontent.com', async () => {
        const manifestUrl = 'https://example.com/some/path/cool-manifest.json';

        webGet.mockImplementation(async (url: string) => {
            if (url === manifestUrl) return {};
            throw new Error(`unexpected url: ${url}`);
        });

        await addModule(context, manifestUrl);

        const modulesRaw = fs.readFileSync(path.join(userRoot, 'imported_modules.yaml'), 'utf-8');
        expect((yaml.load(modulesRaw) as any).modules['cool-manifest']).toBe(manifestUrl);
    });

    it('refuses non-https manifest URLs and does not register anything', async () => {
        await addModule(context, 'http://insecure.example.com/manifest.json');
        expect(fs.existsSync(path.join(userRoot, 'imported_modules.yaml'))).toBe(false);
    });

    it('refuses an unreachable/invalid manifest and does not register it', async () => {
        const manifestUrl = 'https://raw.githubusercontent.com/org/repo/broken.json';
        webGet.mockRejectedValue(new Error('network error'));

        await addModule(context, manifestUrl);
        expect(fs.existsSync(path.join(userRoot, 'imported_modules.yaml'))).toBe(false);
    });
});

describe('removeModule (tyr --del)', () => {
    let userRoot: string;
    let webGet: ReturnType<typeof vi.fn>;
    let context: TyrContext;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-modules-del-'));
        fs.mkdirSync(path.join(userRoot, 'commands'), { recursive: true });
        fs.writeFileSync(path.join(userRoot, 'map.yml'), 'commands: {}\n');

        webGet = vi.fn();

        context = {
            frameworkRoot: '/mock/root',
            userRoot,
            logger: mockLogger,
            fs: new FileSystemManager(mockLogger),
            web: { get: webGet },
            run: vi.fn(),
            task: vi.fn(),
            fail: vi.fn(),
        } as any;
    });

    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    function readModules(): Record<string, string> {
        const raw = fs.readFileSync(path.join(userRoot, 'imported_modules.yaml'), 'utf-8');
        return (yaml.load(raw) as any).modules ?? {};
    }

    function readMap(): { commands: Record<string, string>; aliases?: Record<string, string> } {
        const raw = fs.readFileSync(path.join(userRoot, 'map.yml'), 'utf-8');
        return yaml.load(raw) as any;
    }

    function readLock(): Record<string, any> {
        const raw = fs.readFileSync(path.join(userRoot, 'imported_modules.lock.yml'), 'utf-8');
        return (yaml.load(raw) as any).commands ?? {};
    }

    async function installModule(manifestUrl: string, manifest: Record<string, string>, content: Record<string, string>) {
        fs.writeFileSync(path.join(userRoot, 'imported_modules.yaml'), yaml.dump({ modules: { moduleA: manifestUrl } }));
        webGet.mockImplementation(async (url: string) => {
            if (url === manifestUrl) return manifest;
            const match = Object.entries(manifest).find(([, u]) => u === url);
            if (match) return content[match[0]];
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context);
        webGet.mockReset();
    }

    it('removes the module, its commands, map.yml entries, and lock records', async () => {
        await installModule(
            'https://raw.githubusercontent.com/org/repo/manifestA.json',
            { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts', bar: 'https://raw.githubusercontent.com/org/repo/bar.tyr.ts' },
            { foo: 'export default () => async () => {};', bar: 'export default () => async () => {};' },
        );

        expect(readMap().commands.foo).toBeDefined();
        expect(fs.existsSync(path.join(userRoot, 'commands', 'foo.tyr.ts'))).toBe(true);

        await removeModule(context, 'moduleA');

        expect(readModules().moduleA).toBeUndefined();
        expect(readMap().commands.foo).toBeUndefined();
        expect(readMap().commands.bar).toBeUndefined();
        expect(readLock().foo).toBeUndefined();
        expect(readLock().bar).toBeUndefined();
        expect(fs.existsSync(path.join(userRoot, 'commands', 'foo.tyr.ts'))).toBe(false);
        expect(fs.existsSync(path.join(userRoot, 'commands', 'bar.tyr.ts'))).toBe(false);
    });

    it('also removes the imported .env.<module>.example', async () => {
        await installModule(
            'https://raw.githubusercontent.com/org/repo/manifestA.json',
            { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts', $env: 'https://raw.githubusercontent.com/org/repo/.env.example' },
            { foo: 'export default () => async () => {};', $env: 'API_KEY=\n' },
        );

        expect(fs.existsSync(path.join(userRoot, '.env.moduleA.example'))).toBe(true);

        await removeModule(context, 'moduleA');

        expect(fs.existsSync(path.join(userRoot, '.env.moduleA.example'))).toBe(false);
        const lockRaw = fs.readFileSync(path.join(userRoot, 'imported_modules.lock.yml'), 'utf-8');
        expect((yaml.load(lockRaw) as any).env?.moduleA).toBeUndefined();
    });

    it('also removes aliases pointing at a removed command', async () => {
        await installModule(
            'https://raw.githubusercontent.com/org/repo/manifestA.json',
            { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' },
            { foo: 'export default () => async () => {};' },
        );

        const map = readMap();
        (map as any).aliases = { f: 'foo' };
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump(map));

        await removeModule(context, 'moduleA');

        expect(readMap().aliases?.f).toBeUndefined();
    });

    it('never touches a command re-owned by a different module after a collision', async () => {
        await installModule(
            'https://raw.githubusercontent.com/org/repo/manifestA.json',
            { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' },
            { foo: 'from A' },
        );

        // moduleB takes over 'foo' via a forced sync (simulating tyr --update)
        fs.writeFileSync(
            path.join(userRoot, 'imported_modules.yaml'),
            yaml.dump({
                modules: {
                    moduleA: 'https://raw.githubusercontent.com/org/repo/manifestA.json',
                    moduleB: 'https://raw.githubusercontent.com/org/repo/manifestB.json',
                },
            }),
        );
        webGet.mockImplementation(async (url: string) => {
            if (url.includes('manifestA')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo.tyr.ts' };
            if (url.includes('manifestB')) return { foo: 'https://raw.githubusercontent.com/org/repo/foo-b.tyr.ts' };
            if (url.includes('foo-b.tyr.ts')) return 'from B';
            if (url.includes('foo.tyr.ts')) return 'from A';
            throw new Error(`unexpected url: ${url}`);
        });
        await syncModules(context, { force: true });

        expect(readLock().foo.module).toBe('moduleB');

        await removeModule(context, 'moduleA');

        // 'foo' is now owned by moduleB, so removing moduleA must leave it alone
        expect(readMap().commands.foo).toBeDefined();
        expect(fs.existsSync(path.join(userRoot, 'commands', 'foo.tyr.ts'))).toBe(true);
    });

    it('unregisters a module that has no synced commands (e.g. empty manifest)', async () => {
        fs.writeFileSync(path.join(userRoot, 'imported_modules.yaml'), yaml.dump({ modules: { empty: 'https://raw.githubusercontent.com/org/repo/empty.json' } }));

        await removeModule(context, 'empty');

        expect(readModules().empty).toBeUndefined();
    });

    it('errors when the module is neither registered nor owns any commands', async () => {
        await removeModule(context, 'does-not-exist');
        expect(fs.existsSync(path.join(userRoot, 'imported_modules.yaml'))).toBe(false);
    });
});

describe('generateManifest (tyr --manifest)', () => {
    let userRoot: string;
    let context: TyrContext;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyr-manifest-'));
        fs.mkdirSync(path.join(userRoot, 'commands'), { recursive: true });

        context = {
            frameworkRoot: '/mock/root',
            userRoot,
            logger: mockLogger,
            fs: new FileSystemManager(mockLogger),
            shell: new ShellManager(),
            run: vi.fn(),
            task: vi.fn(),
            fail: vi.fn(),
        } as any;
    });

    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    it('refuses to generate a manifest when ~/.tyr has no linked repository', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));

        await generateManifest(context);

        expect(fs.existsSync(path.join(userRoot, 'manifest.json'))).toBe(false);
    });

    it('refuses when the repo has no "origin" remote configured', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));
        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });

        await generateManifest(context);

        expect(fs.existsSync(path.join(userRoot, 'manifest.json'))).toBe(false);
    });

    it('refuses when the remote is not a GitHub repository', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));
        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });
        await execa('git', ['remote', 'add', 'origin', 'https://gitlab.com/org/repo.git'], { cwd: userRoot });

        await generateManifest(context);

        expect(fs.existsSync(path.join(userRoot, 'manifest.json'))).toBe(false);
    });

    it('generates manifest.json with raw.githubusercontent.com URLs for a linked GitHub repo', async () => {
        fs.writeFileSync(
            path.join(userRoot, 'map.yml'),
            yaml.dump({ commands: { foo: './commands/foo.tyr.ts', bar: './commands/bar.tyr.ts' } }),
        );
        fs.writeFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'export default () => async () => {};');
        fs.writeFileSync(path.join(userRoot, 'commands', 'bar.tyr.ts'), 'export default () => async () => {};');

        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });
        await execa('git', ['remote', 'add', 'origin', 'git@github.com:someuser/tyr-modules.git'], { cwd: userRoot });
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: userRoot });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: userRoot });
        await execa('git', ['add', '.'], { cwd: userRoot });
        await execa('git', ['commit', '-m', 'initial'], { cwd: userRoot });

        await generateManifest(context);

        const manifestPath = path.join(userRoot, 'manifest.json');
        expect(fs.existsSync(manifestPath)).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        expect(manifest.foo).toBe('https://raw.githubusercontent.com/someuser/tyr-modules/main/commands/foo.tyr.ts');
        expect(manifest.bar).toBe('https://raw.githubusercontent.com/someuser/tyr-modules/main/commands/bar.tyr.ts');
    });

    it('includes a $env entry when ~/.tyr/.env.example exists', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));
        fs.writeFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'export default () => async () => {};');
        fs.writeFileSync(path.join(userRoot, '.env.example'), 'API_KEY=\n');

        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });
        await execa('git', ['remote', 'add', 'origin', 'git@github.com:someuser/tyr-modules.git'], { cwd: userRoot });
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: userRoot });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: userRoot });
        await execa('git', ['add', '.'], { cwd: userRoot });
        await execa('git', ['commit', '-m', 'initial'], { cwd: userRoot });

        await generateManifest(context);

        const manifest = JSON.parse(fs.readFileSync(path.join(userRoot, 'manifest.json'), 'utf-8'));
        expect(manifest['$env']).toBe('https://raw.githubusercontent.com/someuser/tyr-modules/main/.env.example');
    });

    it('omits $env when there is no .env.example', async () => {
        fs.writeFileSync(path.join(userRoot, 'map.yml'), yaml.dump({ commands: { foo: './commands/foo.tyr.ts' } }));
        fs.writeFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'export default () => async () => {};');

        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });
        await execa('git', ['remote', 'add', 'origin', 'git@github.com:someuser/tyr-modules.git'], { cwd: userRoot });
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: userRoot });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: userRoot });
        await execa('git', ['add', '.'], { cwd: userRoot });
        await execa('git', ['commit', '-m', 'initial'], { cwd: userRoot });

        await generateManifest(context);

        const manifest = JSON.parse(fs.readFileSync(path.join(userRoot, 'manifest.json'), 'utf-8'));
        expect(manifest['$env']).toBeUndefined();
    });

    it('skips commands whose script lives outside ~/.tyr', async () => {
        fs.writeFileSync(
            path.join(userRoot, 'map.yml'),
            yaml.dump({ commands: { foo: './commands/foo.tyr.ts', outsider: '/tmp/somewhere-else/outsider.tyr.ts' } }),
        );
        fs.writeFileSync(path.join(userRoot, 'commands', 'foo.tyr.ts'), 'export default () => async () => {};');

        await execa('git', ['init', '-b', 'main'], { cwd: userRoot });
        await execa('git', ['remote', 'add', 'origin', 'https://github.com/someuser/tyr-modules.git'], { cwd: userRoot });
        await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: userRoot });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: userRoot });
        await execa('git', ['add', '.'], { cwd: userRoot });
        await execa('git', ['commit', '-m', 'initial'], { cwd: userRoot });

        await generateManifest(context);

        const manifest = JSON.parse(fs.readFileSync(path.join(userRoot, 'manifest.json'), 'utf-8'));
        expect(manifest.foo).toBeDefined();
        expect(manifest.outsider).toBeUndefined();
    });
});
