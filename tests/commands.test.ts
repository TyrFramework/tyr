import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext } from './setup.js';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frameworkRoot = path.resolve(__dirname, '..');

interface TyrConfig {
    commands: Record<string, string>;
    aliases?: Record<string, string>;
}

interface CommandTest {
    args: string[];
    mockInputs?: Record<string, string>;
}

// ─── System Commands: structural tests ──────────────────────────────────────

describe('System Commands', () => {
    const systemCommands = [
        { name: 'gen', path: 'src/core/sys/gen.ts' },
        { name: 'rem', path: 'src/core/sys/rem.ts' },
        { name: 'doc', path: 'src/core/sys/doc.ts' },
    ];

    systemCommands.forEach(({ name, path: cmdPath }) => {
        describe(`tyr ${name}`, () => {
            const absolutePath = path.resolve(frameworkRoot, cmdPath);

            it('exports a default factory function', async () => {
                const module = await import(absolutePath);
                expect(typeof module.default).toBe('function');
            });

            it('factory returns an executable function', async () => {
                const module = await import(absolutePath);
                const ctx = createMockContext();
                expect(typeof module.default(ctx)).toBe('function');
            });
        });
    });
});

// ─── Custom Commands: dynamic tests from exported Test constant ──────────────

describe('Custom Commands', () => {
    const configPath = path.resolve(frameworkRoot, 'config/map.yml');

    if (!fs.existsSync(configPath)) {
        it.skip('No config/map.yml found', () => {});
        return;
    }

    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as TyrConfig;

    if (!config.commands || Object.keys(config.commands).length === 0) {
        it.skip('No custom commands defined', () => {});
        return;
    }

    Object.entries(config.commands).forEach(([commandName, scriptPath]) => {
        const absolutePath = path.resolve(frameworkRoot, scriptPath);

        describe(`tyr ${commandName}`, () => {
            it('file exists and exports a default function', async () => {
                expect(fs.existsSync(absolutePath)).toBe(true);
                const module = await import(absolutePath);
                expect(typeof module.default).toBe('function');
            });

            it('factory returns an executable function', async () => {
                const module = await import(absolutePath);
                const ctx = createMockContext();
                expect(typeof module.default(ctx)).toBe('function');
            });

            // Only run behavioural tests if the command exports a Test constant
            it('runs with Test args if exported', async () => {
                const module = await import(absolutePath);
                const testParams: CommandTest | undefined = module.Test;

                if (!testParams) {
                    console.log(`      (skipped — no Test export found)`);
                    return;
                }

                const ctx = createMockContext();

                // Apply mockInputs to shell.input if provided
                if (testParams.mockInputs) {
                    ctx.shell.input = vi.fn(async (prompt: string) => {
                        for (const [key, value] of Object.entries(testParams.mockInputs!)) {
                            if (prompt.toLowerCase().includes(key.toLowerCase())) return value;
                        }
                        return '';
                    });
                }

                const command = module.default(ctx);

                try {
                    await command(testParams.args);
                } catch (e: any) {
                    // Controlled validation errors are acceptable
                    expect(e.constructor.name).not.toBe('TypeError');
                    expect(e.constructor.name).not.toBe('ReferenceError');
                }
            });
        });
    });
});

// ─── Aliases ─────────────────────────────────────────────────────────────────

describe('Aliases', () => {
    const configPath = path.resolve(frameworkRoot, 'config/map.yml');

    if (!fs.existsSync(configPath)) {
        it.skip('No config/map.yml found', () => {});
        return;
    }

    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as TyrConfig;

    if (!config.aliases || Object.keys(config.aliases).length === 0) {
        it.skip('No aliases defined', () => {});
        return;
    }

    Object.entries(config.aliases).forEach(([alias, target]) => {
        it(`"${alias}" points to existing command "${target}"`, () => {
            expect(config.commands[target]).toBeDefined();
            const targetPath = path.resolve(frameworkRoot, config.commands[target]);
            expect(fs.existsSync(targetPath)).toBe(true);
        });
    });
});
