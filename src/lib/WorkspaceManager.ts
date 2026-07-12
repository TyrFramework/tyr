/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.workspace`. Small, opinionated helpers for the "set up a local
 * project workspace" step of a dev workflow command: confirming/clearing an existing directory,
 * then tagging it with a git branch and optionally opening it in VSCode. Built on
 * {@link ShellManager} and {@link FileSystemManager} rather than duplicating their logic.
 */
import { ShellManager } from './ShellManager.js';
import { FileSystemManager } from './FileSystemManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

/**
 * @class WorkspaceManager
 * @description Manages local workspace directories: checks for existing repos,
 * creates branches and opens the project in VSCode.
 */
export class WorkspaceManager {
    private shell: ShellManager;
    private fs: FileSystemManager;
    private logger: Logger;

    constructor(shell: ShellManager, fs: FileSystemManager, logger: Logger) {
        this.shell = shell;
        this.fs = fs;
        this.logger = logger;
    }

    /**
     * @method checkExisting
     * @description Checks whether a workspace directory already exists.
     * If it does, asks the user if they want to replace it (deleting it first).
     * Returns true if the caller should proceed with creating the workspace.
     * @param {string} dirPath - Absolute path to the workspace directory.
     * @param {string} type - Human-readable type name shown in messages (e.g. 'integration', 'web').
     * @returns {Promise<boolean>} True if the workspace can be created/overwritten.
     * @example
     * const proceed = await workspace.checkExisting('/path/to/repo', 'integration');
     * if (!proceed) return;
     */
    public async checkExisting(dirPath: string, type: string = 'directory'): Promise<boolean> {
        if (!this.fs.exists(dirPath)) return true;

        this.logger.warn(`This ${type} already exists: ${dirPath}`);
        const replace = await this.shell.confirm('Do you want to replace it?', false);

        if (!replace) {
            this.logger.info('Operation cancelled.');
            return false;
        }

        try {
            await this.shell.exec(`rm -rf "${dirPath}"`);
            this.logger.info('Existing directory removed.');
            return true;
        } catch (e) {
            throw new TyrError(`Could not remove existing directory: ${dirPath}`, e);
        }
    }

    /**
     * @method tagWorkspace
     * @description Tags a workspace by creating and checking out a new Git branch,
     * and optionally opening it in VSCode.
     * @param {string} dir - Absolute path to the workspace directory.
     * @param {string | null} branch - Branch name to create (null = skip branch creation).
     * @param {boolean} openCode - Whether to open the directory in VSCode (default: true).
     * @example
     * await workspace.tagWorkspace('/path/to/repo', 'PROJ-123', true);
     */
    public async tagWorkspace(dir: string, branch: string | null, openCode: boolean = true): Promise<void> {
        if (branch) {
            try {
                await this.shell.exec(`git -C "${dir}" checkout -b ${branch}`);
                this.logger.success(`Branch '${branch}' created.`);
            } catch (e) {
                this.logger.warn(`Could not create branch '${branch}'. It may already exist.`);
            }
        }

        if (openCode) {
            try {
                await this.shell.exec(`code "${dir}"`);
            } catch {
                this.logger.warn('Could not open VSCode. Make sure the "code" command is installed.');
            }
        }
    }
}

export const WorkspaceManagerTests = {
    checkExisting: { dirPath: '/tmp/tyr-workspace-test', type: 'integration' },
    tagWorkspace: { dir: '/tmp/tyr-workspace-test', branch: null, openCode: false },
};
