/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.pkg`. Installs OS-level *system* packages (e.g. `nginx`,
 * `python3`) via whichever native package manager is detected on the host — distinct from
 * `npm`/node dependencies, which commands manage with their own tooling. Built on top of
 * {@link ShellManager} rather than talking to any package manager's API directly.
 */
import { ShellManager } from './ShellManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

/**
 * @class PackageManager
 * @description OS-agnostic package manager. Automatically detects whether the system uses apt, brew or dnf and installs native software.
 */
export class PackageManager {
    private shell: ShellManager;
    private logger: Logger;
    private manager: string | null;

    constructor(shell: ShellManager, logger: Logger) {
        this.shell = shell;
        this.logger = logger;
        this.manager = null;
    }

    /**
     * @method detect
     * @description Attempts to identify the package manager installed on the host system.
     * @returns {Promise<string>} The name of the detected binary ('apt', 'brew', 'dnf').
     * @example
     * const mgr = await pkg.detect();
     * logger.info(`Using: ${mgr}`);
     */
    public async detect(): Promise<string> {
        if (this.manager) return this.manager;

        const isWindows = process.platform === 'win32';
        const checkCmd = isWindows ? 'where' : 'which';

        const candidates: [string, string][] = isWindows
            ? [['winget', 'winget'], ['choco', 'choco'], ['scoop', 'scoop']]
            : [['apt-get', 'apt'], ['brew', 'brew'], ['dnf', 'dnf']];

        for (const [bin, name] of candidates) {
            try {
                await this.shell.exec(`${checkCmd} ${bin}`);
                this.manager = name;
                return name;
            } catch (e) {}
        }

        throw new TyrError(
            'No supported package manager detected.',
            null,
            isWindows
                ? 'Install winget (Windows Package Manager), Chocolatey, or Scoop.'
                : 'Make sure apt, brew or dnf is installed on your system.'
        );
    }

    /**
     * @method install
     * @description Installs a system package using the detected package manager.
     * @param {string} packageName - Name of the package to install (e.g. 'nginx', 'python3').
     * @example
     * await pkg.install('nginx');
     */
    public async install(packageName: string): Promise<void> {
        const mgr = await this.detect();
        this.logger.info(`Installing ${packageName} using ${mgr}...`);

        const commands: Record<string, string> = {
            apt: `sudo apt-get install -y ${packageName}`,
            brew: `brew install ${packageName}`,
            dnf: `sudo dnf install -y ${packageName}`,
            winget: `winget install ${packageName}`,
            choco: `choco install -y ${packageName}`,
            scoop: `scoop install ${packageName}`,
        };

        try {
            await this.shell.exec(commands[mgr]);
            this.logger.success(`Package ${packageName} installed.`);
        } catch (e) {
            if (e instanceof TyrError) throw e;
            throw new TyrError(`Could not install package: ${packageName}`, e, `Try running the install command manually with ${mgr}.`);
        }
    }
}

export const PackageManagerTests = {
    detect: {},
};
