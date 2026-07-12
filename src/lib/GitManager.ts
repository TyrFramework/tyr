/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.git`. Most methods run through {@link ShellManager} (and so
 * operate in that instance's current working directory), except `status()`/`diff()`, which call
 * `execa` directly against an explicit `dir` argument — see their own doc comments below for why:
 * they're read-only, directory-scoped checks called speculatively by the AI agent loop in
 * {@link AIContextManager}, and shouldn't mutate ShellManager's shared cwd to do it.
 */
import { execa } from 'execa';

import { ShellManager } from './ShellManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

/**
 * @class GitManager
 * @description Wrapper for common Git operations. Automates repository initialization, commits and cloning.
 */
export class GitManager {
    private shell: ShellManager;
    private logger: Logger;

    constructor(shell: ShellManager, logger: Logger) {
        this.shell = shell;
        this.logger = logger;
    }

    /**
     * @method init
     * @description Initializes a Git repository in the current directory and renames the default branch to 'main'.
     * @example
     * await git.init();
     */
    public async init(): Promise<void> {
        try { await this.shell.exec('git init'); await this.shell.exec('git branch -M main'); } catch (e) {
            throw new TyrError(`Could not init git repository`, e, 'Check if the current directory still exists.');
        }
    }

    /**
     * @method addAll
     * @description Stages all files in the current directory (git add .).
     * @example
     * await git.addAll();
     */
    public async addAll(): Promise<void> {
        await this.shell.exec('git add .');
    }

    /**
     * @method commit
     * @description Creates a commit with the provided message.
     * @param {string} message - The commit message.
     * @example
     * await git.commit("feat: initial project structure");
     */
    public async commit(message: string): Promise<void> {
        await this.shell.exec(`git commit -m "${message}"`);
        this.logger.success(`Commit created: "${message}"`);
    }

    /**
     * @method clone
     * @description Clones a remote repository into the current directory.
     * @param {string} repoUrl - The HTTPS or SSH URL of the repository.
     * @example
     * await git.clone('https://github.com/user/repo.git');
     */
    public async clone(repoUrl: string): Promise<void> {
        this.logger.info(`Cloning ${repoUrl}...`);
        try {
            await this.shell.exec(`git clone ${repoUrl}`);
        } catch (e) {
            throw new TyrError(`Could not find the repository ` + repoUrl, e, 'Check if the repository exists or if you have the right permissions to clone it.');
        }
    }

    /**
     * @method cloneTo
     * @description Clones a remote repository into a specific target directory.
     * @param {string} repoUrl - The HTTPS or SSH URL of the repository.
     * @param {string} destDir - The absolute path of the destination directory.
     * @example
     * await git.cloneTo('git@github.com:org/repo.git', '/path/to/dest');
     */
    public async cloneTo(repoUrl: string, destDir: string): Promise<void> {
        this.logger.info(`Cloning ${repoUrl}...`);
        const loader = this.shell.showLoader('Cloning repository...');
        try {
            await this.shell.exec(`git clone "${repoUrl}" "${destDir}"`);
            await this.shell.exec(`git -C "${destDir}" config --add core.filemode false`);
            loader.stop();
            this.logger.success('Cloning complete.');
        } catch (e) {
            loader.stop();
            throw new TyrError(`Could not clone repository: ${repoUrl}`, e, 'Check that the repository exists and that you have permission to clone it.');
        }
    }

    /**
     * @method checkRepoExists
     * @description Checks if a remote Git repository is accessible via ls-remote.
     * @param {string} repoUrl - The URL of the repository to check.
     * @returns {Promise<boolean>} True if the repository is reachable.
     * @example
     * const exists = await git.checkRepoExists('git@github.com:org/repo.git');
     */
    public async checkRepoExists(repoUrl: string): Promise<boolean> {
        try {
            await this.shell.exec(`git ls-remote "${repoUrl}" HEAD`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @method initWithRemote
     * @description Removes an existing .git folder if present, then initialises a new Git repository
     * in the given directory and configures a remote origin.
     * @param {string} dir - The absolute path of the directory to initialise.
     * @param {string} remoteUrl - The remote URL to set as origin.
     * @example
     * await git.initWithRemote('/path/to/dir', 'git@github.com:org/repo.git');
     */
    public async initWithRemote(dir: string, remoteUrl: string): Promise<void> {
        try {
            await this.shell.exec(
                `cd "${dir}" && rm -rf .git && git init -b master && git remote add origin "${remoteUrl}" && git config --add core.filemode false && echo 'node_modules' >> .gitignore`
            );
            this.logger.success(`Git repository initialized at ${dir}`);
        } catch (e) {
            throw new TyrError(`Could not initialize git repository at ${dir}`, e);
        }
    }

    /**
     * @method status
     * @description Read-only `git status --porcelain` for an arbitrary directory. Unlike the rest
     * of this class, this targets `dir` directly via execa instead of the shared ShellManager's
     * mutate-then-run cwd (the same reasoning AIContextManager.runValidation() already has to work
     * around by saving/restoring the shell's cwd itself) — a read-only, dir-scoped check has no
     * business touching shared state. Never throws: returns a friendly string for "not a repo" or
     * "git unavailable" instead, since this is called speculatively by the AI agent's tool loop.
     * @param {string} dir - Absolute path to check.
     * @returns {Promise<string>} Porcelain status output, or a friendly explanation if unavailable.
     * @example
     * const status = await git.status('/path/to/project');
     */
    public async status(dir: string): Promise<string> {
        try {
            const result = await execa('git', ['status', '--porcelain'], { cwd: dir, reject: false });
            if (result.exitCode !== 0) {
                return `Not a git repository, or git status failed: ${String(result.stderr || result.stdout).trim()}`;
            }
            return result.stdout.trim() || '(clean — no changes)';
        } catch (e: any) {
            return `git is not available: ${e?.message ?? String(e)}`;
        }
    }

    /**
     * @method diff
     * @description Read-only `git diff` (working tree, or `--staged`) for an arbitrary directory.
     * Same execa-direct, never-throws convention as status() — see its doc for why.
     * @param {string} dir - Absolute path to diff.
     * @param {{ staged?: boolean }} options - Pass `staged: true` for `git diff --staged`.
     * @returns {Promise<string>} Unified diff text, or a friendly explanation if unavailable.
     * @example
     * const diff = await git.diff('/path/to/project');
     */
    public async diff(dir: string, options: { staged?: boolean } = {}): Promise<string> {
        const args = ['diff', ...(options.staged ? ['--staged'] : [])];
        try {
            const result = await execa('git', args, { cwd: dir, reject: false });
            if (result.exitCode !== 0) {
                return `git diff failed: ${String(result.stderr || result.stdout).trim()}`;
            }
            return result.stdout.trim() || '(no differences)';
        } catch (e: any) {
            return `git is not available: ${e?.message ?? String(e)}`;
        }
    }
}

/**
 * @object GitManagerTests
 * @description Test parameters to validate GitManager functionality.
 */
export const GitManagerTests = {
    init: { directory: '/tmp/tyr-git-test' },
    addAll: { directory: '/tmp/tyr-git-test' },
};