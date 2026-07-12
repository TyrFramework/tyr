/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.sandbox`. Used by {@link AIContextManager}'s `runCodeAgent()` as
 * the final "does this actually run" check after the AI's patches are applied and compile/lint
 * validation passes — see this class's own doc comment for exactly what it does and does not
 * isolate.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';

import { Logger } from '../core/Logger.js';
import { getEnvInt } from '../core/util/getenv.js';

// Kept textually in sync with AIContextManager's own DEFAULT_IGNORED_DIRS — not imported from
// there on purpose, so SandboxManager stays independent of AIContextManager's internals.
const IGNORED_DIRS = new Set<string>([
    'node_modules', '.git', '.hg', '.svn',
    '.turbo', '.next', '.nuxt', '.cache', '.parcel-cache',
    '.vscode', '.idea',
    'dist', 'build', 'out', 'coverage', '.nyc_output',
    'target', 'vendor',
]);

// npm's own placeholder for a project with no real tests yet — never worth "running".
const NPM_DEFAULT_TEST_SCRIPT = /^echo\s+"Error: no test specified"\s*&&\s*exit\s+1$/i;

const SANDBOX_TIMEOUT_MS = getEnvInt('SANDBOX_TIMEOUT_MS', 120000);
const MAX_OUTPUT_CHARS = 8000;

export interface SandboxResult {
    ran: boolean;
    ok: boolean;
    /** The `npm run <script>` command actually executed, if any. */
    command?: string;
    /** Captured stdout/stderr, only populated on failure (truncated). */
    output?: string;
}

function truncate(text: string, maxChars: number = MAX_OUTPUT_CHARS): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... (truncated, ${text.length - maxChars} more characters)`;
}

/**
 * @class SandboxManager
 * @description Runs a project's own test/build command in an isolated temp copy, as an extra
 * verification step on top of AIContextManager's compile/lint validation — "does this actually
 * work", not just "does it typecheck". Copies source files (skipping the same kind of noise
 * directories the rest of the codebase already ignores) into a fresh temp directory, symlinks the
 * original `node_modules` in rather than reinstalling (fast, and installing isn't this class's
 * job), and executes with a hard timeout. Never touches the real project directory. Not a real OS
 * sandbox (no container, no network/resource limits) — a deliberate scope choice, cheap to run
 * for a personal tool; revisit if this ever needs to run untrusted code.
 */
export class SandboxManager {
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * @method verify
     * @description Copies `projectDir` into a temp directory and runs its `test` script (or
     * `build` if there's no real `test` script), reporting pass/fail. Returns `{ran: false, ok:
     * true}` — the same "assume ok, nothing to check" convention AIContextManager's
     * runValidation() uses — when the project has no package.json or no test/build script.
     * @param {string} projectDir - Absolute path to the project to verify.
     * @returns {Promise<SandboxResult>}
     * @example
     * const result = await sandbox.verify('/path/to/project');
     * if (!result.ran || result.ok) { ... } // "assume ok" when nothing was checked
     */
    public async verify(projectDir: string): Promise<SandboxResult> {
        const script = await this.detectScript(projectDir);
        if (!script) return { ran: false, ok: true };

        const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'tyr-sandbox-'));
        try {
            await this.copySource(projectDir, tempDir);
            this.linkNodeModules(projectDir, tempDir);

            const command = `npm run ${script}`;
            try {
                const result = await execa('npm', ['run', script], {
                    cwd: tempDir,
                    timeout: SANDBOX_TIMEOUT_MS,
                    reject: false,
                });
                const ok = result.exitCode === 0;
                return {
                    ran: true,
                    ok,
                    command,
                    output: ok ? undefined : truncate(String(result.stderr || result.stdout || 'Unknown sandbox failure')),
                };
            } catch (e: any) {
                return { ran: true, ok: false, command, output: truncate(e?.message ?? String(e)) };
            }
        } finally {
            fsSync.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    /** Picks which npm script to run: a real `test` script if present (ignoring npm's own
     *  `"no test specified"` placeholder — see NPM_DEFAULT_TEST_SCRIPT), else `build`, else `null`
     *  (nothing to verify). */
    private async detectScript(projectDir: string): Promise<'test' | 'build' | null> {
        const pkgPath = path.join(projectDir, 'package.json');
        if (!fsSync.existsSync(pkgPath)) return null;

        let scripts: Record<string, string> = {};
        try {
            const raw = await fs.readFile(pkgPath, 'utf-8');
            scripts = JSON.parse(raw).scripts ?? {};
        } catch {
            return null;
        }

        if (scripts.test && !NPM_DEFAULT_TEST_SCRIPT.test(scripts.test.trim())) return 'test';
        if (scripts.build) return 'build';
        return null;
    }

    /** Recursively copies `srcDir` into `destDir`, skipping `node_modules`/`IGNORED_DIRS` and any
     *  symlink (to avoid following a symlink back out of the temp sandbox). */
    private async copySource(srcDir: string, destDir: string): Promise<void> {
        const entries = await fs.readdir(srcDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === 'node_modules' || IGNORED_DIRS.has(entry.name)) continue;
            if (entry.isSymbolicLink()) continue;

            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);

            if (entry.isDirectory()) {
                await fs.mkdir(destPath, { recursive: true });
                await this.copySource(srcPath, destPath);
            } else if (entry.isFile()) {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    /** Symlinks the real `node_modules` into the temp copy instead of reinstalling — reinstalling
     *  would be both slow and out of scope for a verification step (see the class doc). Warns
     *  rather than throwing if the symlink fails, since `verify()` should still attempt the run. */
    private linkNodeModules(projectDir: string, tempDir: string): void {
        const original = path.join(projectDir, 'node_modules');
        if (!fsSync.existsSync(original)) return;
        try {
            fsSync.symlinkSync(original, path.join(tempDir, 'node_modules'), 'dir');
        } catch (e: any) {
            this.logger.warn(`Sandbox: could not symlink node_modules (${e?.message ?? e}); the check may fail if dependencies are needed.`);
        }
    }
}

/**
 * @object SandboxManagerTests
 * @description Test parameters to validate SandboxManager functionality.
 */
export const SandboxManagerTests = {};
