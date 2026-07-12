#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { ShellManager } from '../src/lib/ShellManager.js';
import { FileSystemManager } from '../src/lib/FileSystemManager.js';
import { PackageManager } from '../src/lib/PackageManager.js';
import { DockerManager } from '../src/lib/DockerManager.js';
import { GitManager } from '../src/lib/GitManager.js';
import { SystemManager } from '../src/lib/SystemManager.js';
import { SQLManager } from '../src/lib/SQLManager.js';
import { WebManager } from '../src/lib/WebManager.js';
import { AIVendorManager } from '../src/lib/AIVendorManager.js';
import { AIContextManager } from '../src/lib/AIContextManager.js';
import { SandboxManager } from '../src/lib/SandboxManager.js';
import { MemoryManager } from '../src/lib/MemoryManager.js';
import { PromptTemplateManager } from '../src/lib/PromptTemplateManager.js';
import { TokenManager } from '../src/lib/TokenManager.js';
import { ChatManager } from '../src/lib/ChatManager.js';
import { createLogger } from '../src/core/Logger.js';
import { TyrContext } from '../src/core/Kernel.js';

import { DockerManagerTests } from '../src/lib/DockerManager.js';
import { FileSystemManagerTests } from '../src/lib/FileSystemManager.js';
import { GitManagerTests } from '../src/lib/GitManager.js';
import { PackageManagerTests } from '../src/lib/PackageManager.js';
import { SQLManagerTests } from '../src/lib/SQLManager.js';
import { SystemManagerTests } from '../src/lib/SystemManager.js';
import { WebManagerTests } from '../src/lib/WebManager.js';
import { ShellManagerTests } from '../src/lib/ShellManager.js';
import { AIContextManagerTests } from '../src/lib/AIContextManager.js';
import { SandboxManagerTests } from '../src/lib/SandboxManager.js';
import { MemoryManagerTests } from '../src/lib/MemoryManager.js';
import { PromptTemplateManagerTests } from '../src/lib/PromptTemplateManager.js';
import { TokenManagerTests } from '../src/lib/TokenManager.js';
import { ChatManagerTests } from '../src/lib/ChatManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
    name: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    details?: string;
    error?: string;
}

interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

interface CommandTest {
    args: string[];
    mockInputs?: Record<string, string>;
}

const frameworkRoot = path.resolve(__dirname, '..');
const logger = createLogger(false);
const results: TestResult[] = [];

// ─── Manager Smoke Tests ─────────────────────────────────────────────────────

async function testManagers(): Promise<void> {
    console.log('\n── Managers ─────────────────────────────────────────────\n');

    const shell = new ShellManager();
    const fs = new FileSystemManager(logger);
    const aiVendor = new AIVendorManager(logger);
    const git = new GitManager(shell, logger);
    const sandbox = new SandboxManager(logger);
    const aiContext = new AIContextManager(fs, shell, aiVendor, logger, git, sandbox);

    const managers = [
        { name: 'ShellManager',           instance: new ShellManager(),                        tests: ShellManagerTests },
        { name: 'FileSystemManager',      instance: fs,                                        tests: FileSystemManagerTests },
        { name: 'DockerManager',          instance: new DockerManager(shell, logger),          tests: DockerManagerTests },
        { name: 'GitManager',             instance: git,                                       tests: GitManagerTests },
        { name: 'PackageManager',         instance: new PackageManager(shell, logger),         tests: PackageManagerTests },
        { name: 'SQLManager',             instance: new SQLManager(),                          tests: SQLManagerTests },
        { name: 'SystemManager',          instance: new SystemManager(shell, logger),          tests: SystemManagerTests },
        { name: 'WebManager',             instance: new WebManager(logger),                    tests: WebManagerTests },
        { name: 'AIContextManager',       instance: aiContext,                                 tests: AIContextManagerTests },
        { name: 'SandboxManager',         instance: sandbox,                                   tests: SandboxManagerTests },
        { name: 'MemoryManager',          instance: new MemoryManager(fs, logger),             tests: MemoryManagerTests },
        { name: 'PromptTemplateManager',  instance: new PromptTemplateManager(aiContext, logger), tests: PromptTemplateManagerTests },
        { name: 'TokenManager',           instance: new TokenManager(logger),                  tests: TokenManagerTests },
        { name: 'ChatManager',            instance: new ChatManager(fs, logger),               tests: ChatManagerTests },
    ];

    for (const { name, instance, tests } of managers) {
        if (!tests || Object.keys(tests).length === 0) {
            console.log(`  ⊘ ${name} — no tests defined, skipping`);
            results.push({ name, status: 'SKIP' });
            continue;
        }

        const methodResults: { method: string; status: 'PASS' | 'FAIL'; error?: string }[] = [];

        for (const [methodName, params] of Object.entries(tests)) {
            try {
                const method = (instance as any)[methodName];
                if (typeof method !== 'function') throw new Error('Not a function');

                const args = Object.values(params as Record<string, unknown>);
                await method.apply(instance, args);

                console.log(`  ✔ ${name}.${methodName}()`);
                methodResults.push({ method: methodName, status: 'PASS' });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.log(`  ✖ ${name}.${methodName}() — ${msg}`);
                methodResults.push({ method: methodName, status: 'FAIL', error: msg });
            }
        }

        const failed = methodResults.filter(r => r.status === 'FAIL');
        results.push({
            name,
            status: failed.length === 0 ? 'PASS' : 'FAIL',
            details: `${methodResults.filter(r => r.status === 'PASS').length}/${methodResults.length} methods passed`,
            error: failed.map(f => `${f.method}: ${f.error}`).join('; ') || undefined,
        });
    }
}

// ─── Command Smoke Tests ─────────────────────────────────────────────────────

function buildSmokeContext(testParams: CommandTest): TyrContext {
    const noop = () => {};
    const noopAsync = async () => {};

    return {
        frameworkRoot,
        logger,
        shell: {
            cd: noop,
            exec: async (cmd: string) => { console.log(`   → exec: ${cmd}`); return ''; },
            input: async (prompt: string) => {
                if (testParams.mockInputs) {
                    for (const [key, value] of Object.entries(testParams.mockInputs)) {
                        if (prompt.toLowerCase().includes(key.toLowerCase())) return value;
                    }
                }
                return '';
            },
            showLoader: (_msg: string) => ({ stop: noop }),
        },
        fs: {
            exists: (_p: string) => true,
            read: async (_p: string) => '# smoke content',
            write: noopAsync,
            createDir: noopAsync,
            delete: noopAsync,
            ensureLine: noopAsync,
        },
        db:     { searchBrokerOnDB: async () => 'smoke-broker', execute: noopAsync },
        git:    { clone: noopAsync, commit: noopAsync, addAll: noopAsync, init: noopAsync },
        docker: { run: noopAsync, composeUp: noopAsync, containerExists: async () => false, isRunning: async () => true },
        web:    { selectFromWeb: async () => [] },
        pkg:    { install: noopAsync, detect: async () => 'apt' },
        sys:    { killPort: async () => true, nukeNodeModules: noopAsync },
        task: async (_desc: string, action: () => any, next = false, onFail?: () => void) => {
            try { return await action(); }
            catch (e) { if (onFail) onFail(); if (!next) throw e; }
        },
        run:  async (cmd: string, args: string[] = []) => { console.log(`   → run: ${cmd} [${args.join(', ')}]`); },
        fail: (msg: string, suggestion?: string): never => {
            const e = new Error(msg);
            (e as any).suggestion = suggestion;
            throw e;
        },
    } as unknown as TyrContext;
}

async function testCommands(config: TyrConfig): Promise<void> {
    console.log('\n── Commands ─────────────────────────────────────────────\n');

    for (const [name, scriptPath] of Object.entries(config.commands)) {
        const absolutePath = path.resolve(frameworkRoot, scriptPath);

        if (!fs.existsSync(absolutePath)) {
            console.log(`  ✖ ${name} — file not found: ${scriptPath}`);
            results.push({ name, status: 'FAIL', error: `File not found: ${scriptPath}` });
            continue;
        }

        try {
            const module = await import(absolutePath);

            if (typeof module.default !== 'function') {
                throw new Error('Does not export a default function');
            }

            const testParams: CommandTest | undefined = module.Test;

            if (!testParams) {
                console.log(`  ⊘ ${name} — no Test export, skipping execution`);
                results.push({ name, status: 'SKIP', details: scriptPath });
                continue;
            }

            const ctx = buildSmokeContext(testParams);
            const command = module.default(ctx);
            await command(testParams.args);

            console.log(`  ✔ ${name}`);
            results.push({ name, status: 'PASS', details: scriptPath });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ✖ ${name} — ${msg}`);
            results.push({ name, status: 'FAIL', error: msg });
        }
    }
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printReport(): void {
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;
    const total = results.length;

    console.log('\n════════════════════════════════════════════════════════');
    console.log(`  SMOKE RESULTS:  ✔ ${passed}  ✖ ${failed}  ⊘ ${skipped}  (${total} total)`);
    console.log('════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        console.log('Failures:');
        results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`  ✖ ${r.name}: ${r.error}`);
        });
        process.exit(1);
    } else {
        console.log('All smoke tests passed.\n');
        process.exit(0);
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

(async () => {
    console.log('════════════════════════════════════════════════════════');
    console.log('  TYR FRAMEWORK — SMOKE TESTING');
    console.log('════════════════════════════════════════════════════════');

    const configPath = path.resolve(frameworkRoot, 'config/map.yml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as TyrConfig;

    await testManagers();
    await testCommands(config);
    printReport();
})();
