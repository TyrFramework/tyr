/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.shell`. This is the framework's lowest-level building block for
 * running system commands and prompting the user interactively — several other Managers
 * (`GitManager`, `DockerManager`, `PackageManager`, `SetupManager`, `SystemManager`,
 * `WorkspaceManager`) are thin wrappers that call into a `ShellManager` instance rather than
 * shelling out themselves, so this class is the one place command execution and its error
 * handling (wrapped in {@link TyrError}) actually happens.
 */
import { execa } from 'execa';
import { resolve } from 'path';
import { homedir } from 'os';
import inquirer from 'inquirer';

import { TyrError } from '../core/TyrError.js';

/**
 * @class ShellManager
 * @description Terminal command executor. Maintains the working directory (CWD) state to chain commands in specific folders.
 */
export class ShellManager {
    private cwd: string;

    constructor() {
        this.cwd = process.cwd();
    }

    /**
     * @method exec
     * @description Executes a command in the system shell and returns the standard output.
     * @param {string} command - The full command to execute.
     * @returns {Promise<string>} The command output (stdout) trimmed of extra whitespace.
     * @example
     * const version = await shell.exec('node -v');
     */
    public async exec(command: string): Promise<string> {
        try {
            const result = await execa(command, { shell: true, cwd: this.cwd });
            return result.stdout.trim();
        } catch (e) {
            throw new TyrError(`An error occurred while executing the command: ${command}`, e);
        }
    }

    /**
    * @method showLoader
    * @description Displays a spinner loader in the terminal.
    * @param {string} message - Informational text to show alongside the spinner.
    * @returns {void}
    * @example
    * shell.showLoader('Loading...');
    */
    public showLoader = (message: string): { stop: () => void } => {
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let i = 0;
        let stopped = false;

        const interval = setInterval(() => {
            if (!stopped) {
                process.stdout.write(`\r${frames[i]} ${message}`);
                i = (i + 1) % frames.length;
            }
        }, 80);

        return {
            stop: () => {
                stopped = true;
                clearInterval(interval);
                process.stdout.write('\r');
            }
        };
    };

    /**
     * @method input
     * @description Prompts the user for a value via CLI.
     * @param {string} question - Informational text shown as the prompt.
     * @returns {Promise<string>} The value entered by the user.
     * @example
     * const name = await shell.input("What's your name?");
     */
    public async input(question: string): Promise<string> {
        try {
            const result = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'value',
                    message: question,
                },
            ]);

            return result.value.trim();
        } catch (e) {
            throw new TyrError(`An error occurred while prompting the question: ${question}`, e);
        }
    }

    /**
     * @method cd
     * @description Changes the internal working directory for subsequent commands executed by this instance.
     * @param {string} path - Absolute or relative path to change to.
     * @example
     * shell.cd('./backend');
     * await shell.exec('npm install'); // Runs inside /backend
     */
    public cd(path: string): void {
        let expandedPath = path;
        if (path.startsWith('~/')) {
            expandedPath = path.replace('~', homedir());
        } else if (path === '~') {
            expandedPath = homedir();
        }

        this.cwd = resolve(this.cwd, expandedPath);
    }

    /**
     * @method getCwd
     * @description Returns the current working directory used by this instance.
     * @returns {string} The current working directory.
     * @example
     * const dir = shell.getCwd();
     */
    public getCwd(): string {
        return this.cwd;
    }

    /**
     * @method confirm
     * @description Prompts the user with a yes/no question via CLI.
     * @param {string} question - The question to display.
     * @param {boolean} defaultValue - Default answer if user presses Enter (default: false).
     * @returns {Promise<boolean>} True if the user confirmed.
     * @example
     * const ok = await shell.confirm('Continue?', false);
     */
    public async confirm(question: string, defaultValue: boolean = false): Promise<boolean> {
        try {
            const result = await inquirer.prompt([{
                type: 'confirm',
                name: 'value',
                message: question,
                default: defaultValue,
            }]);
            return result.value;
        } catch (e) {
            throw new TyrError(`Error showing confirmation: ${question}`, e);
        }
    }

    /**
     * @method select
     * @description Prompts the user to select one option from a list.
     * @param {Array<{name: string, value: string}>} choices - The available options.
     * @param {string} question - The question to display.
     * @returns {Promise<string>} The selected value.
     * @example
     * const branch = await shell.select([{ name: 'main', value: 'main' }], 'Which branch?');
     */
    public async select(choices: { name: string; value: string }[], question: string): Promise<string> {
        try {
            const result = await inquirer.prompt([{
                type: 'list',
                name: 'value',
                message: question,
                choices,
            }]);
            return result.value;
        } catch (e) {
            throw new TyrError(`Error showing selection: ${question}`, e);
        }
    }

    /**
     * @method checkbox
     * @description Prompts the user to select multiple options from a list.
     * @param {Array<{name: string, value: string}>} choices - The available options.
     * @param {string} question - The question to display.
     * @returns {Promise<string[]>} The selected values.
     * @example
     * const widgets = await shell.checkbox(choices, 'Which widgets to include?');
     */
    public async checkbox(choices: { name: string; value: string }[], question: string): Promise<string[]> {
        try {
            const result = await inquirer.prompt([{
                type: 'checkbox',
                name: 'value',
                message: question,
                choices,
            }]);
            return result.value;
        } catch (e) {
            throw new TyrError(`Error showing options: ${question}`, e);
        }
    }
}

/**
 * @object ShellManagerTests
 * @description Test parameters to validate ShellManager functionality.
 */
export const ShellManagerTests = {
    exec: { command: 'node -v' },
    cd: { path: '/tmp' },
    input: { question: 'Enter a test value:' },
    showLoader: { message: 'Loading test...' },
    confirm: { question: 'Continue?', defaultValue: false },
    select: { choices: [{ name: 'Option A', value: 'a' }, { name: 'Option B', value: 'b' }], question: 'Which one?' },
    checkbox: { choices: [{ name: 'Item 1', value: '1' }, { name: 'Item 2', value: '2' }], question: 'Which ones?' },
};