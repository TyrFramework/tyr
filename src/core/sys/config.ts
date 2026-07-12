/**
 * @fileoverview Built-in `tyr --config [--repo <url>]` command — bootstraps (or re-bootstraps)
 * `~/.tyr`, the user root every other part of the framework reads from (`map.yml`,
 * `imported_modules.yaml`, `commands/`, `.env`, shell aliases/plugins). Unlike the other files in
 * `sys/`, this one is invoked directly by name from `Kernel.handle()` (the `--config` flag) rather
 * than through the `systemCommands` table, since it has to run before a normal `TyrContext.run()`
 * cycle would make sense (there may be no `map.yml` yet to load).
 *
 * With no `--repo`, this initialises a fresh, empty `~/.tyr` from the templates below. With
 * `--repo <url>`, it clones that repository into `~/.tyr` instead — letting a team share one
 * `~/.tyr` configuration (commands, aliases, `map.yml`) via git, exactly as `tyr --update` later
 * pulls from that same linked repo (see `Kernel.handle()`'s `--update` branch).
 */
import path from 'path';
import { getEnvString } from '../util/getenv.js';
import { homedir, platform } from 'os';
import { existsSync, cpSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import type { TyrContext } from '../Kernel';

/** Recursively deletes a directory. Shells out to `rd /s /q` on Windows rather than using
 *  `fs.rmSync` there, since `rmSync`'s recursive delete has historically been unreliable against
 *  Windows file locks in some Node versions — the native `rd` command handles that natively. */
function removeDirRecursive(dirPath: string): void {
    if (platform() === 'win32') {
        execSync(`rd /s /q "${dirPath}"`, { stdio: 'pipe' });
    } else {
        rmSync(dirPath, { recursive: true, force: true });
    }
}

function clearDirExceptLogs(dirPath: string): void {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.name === 'logs') continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            removeDirRecursive(fullPath);
        } else {
            rmSync(fullPath, { force: true });
        }
    }
}

function copyDirContents(srcDir: string, destDir: string): void {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        cpSync(
            path.join(srcDir, entry.name),
            path.join(destDir, entry.name),
            { recursive: true, force: true },
        );
    }
}

/** Copies everything in `userRoot` into `backupPath`, skipping the `logs/` folder (backing up log
 *  files on every `tyr --config` run would be pure waste — they're not configuration). */
function backupUserRoot(userRoot: string, backupPath: string): void {
    mkdirSync(backupPath, { recursive: true });
    for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
        if (entry.name === 'logs') continue;
        cpSync(
            path.join(userRoot, entry.name),
            path.join(backupPath, entry.name),
            { recursive: true },
        );
    }
}

/** Picks the shell rc file to append `source` lines to, based on `$SHELL`. Falls back to checking
 *  which of `.zshrc`/`.bashrc`/`.bash_profile` actually exists if `$SHELL` is unset or unrecognised,
 *  since a missing/wrong rc file would make the aliases/plugins silently never load. */
function detectShellRcFile(homeDir: string): string | null {
    const shell = getEnvString('SHELL', '');
    if (shell.includes('zsh'))  return path.join(homeDir, '.zshrc');
    if (shell.includes('fish')) return path.join(homeDir, '.config', 'fish', 'config.fish');
    if (shell.includes('bash')) {
        const candidates = [path.join(homeDir, '.bash_profile'), path.join(homeDir, '.bashrc')];
        return candidates.find(p => existsSync(p)) ?? path.join(homeDir, '.bashrc');
    }
    const fallbacks = [path.join(homeDir, '.zshrc'), path.join(homeDir, '.bashrc'), path.join(homeDir, '.bash_profile')];
    return fallbacks.find(p => existsSync(p)) ?? path.join(homeDir, '.bashrc');
}

function getWindowsProfilePaths(): string[] {
    const userProfile = getEnvString('USERPROFILE');
    if (!userProfile) return [];
    return [
        path.join(userProfile, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
        path.join(userProfile, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ];
}

async function checkWindowsExecutionPolicy(shell: any, logger: any): Promise<void> {
    try {
        const output: string = await shell.exec(
            'powershell -NoProfile -Command "Get-ExecutionPolicy -Scope CurrentUser"',
        );
        const policy = String(output).trim();

        if (policy === 'Restricted' || policy === 'AllSigned' || policy === 'Undefined') {
            logger.warn(`\nCurrent Execution Policy: ${policy || 'Undefined'}`);
            logger.warn('With this policy, PowerShell may block loading your profile (and therefore Tyr functions/aliases).');
            logger.info('To allow it, run in a PowerShell console:');
            logger.info('  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser');
        }
    } catch {
        logger.warn('Could not check PowerShell Execution Policy. Verify it manually if commands do not load.');
    }
}

const PACKAGE_JSON_TEMPLATE = `{
  "name": "tyr-commands",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "description": "Custom Tyr commands (~/.tyr/)",
  "dependencies": {
    "@tyrframework/cli": "latest"
  }
}
`;

const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["commands/**/*.ts"]
}
`;

const ENV_TEMPLATE = `# Environment variables for Tyr. This file must never be committed to git.
#
# SQL Server database
MSSQL_USER=
MSSQL_PASSWORD=
MSSQL_SERVER=
MSSQL_DATABASE=
# MongoDB database
MONGO_URI=
MONGO_DATABASE=
# AI vendor (anthropic | openai | gemini)
AI_VENDOR=anthropic
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
AI_MODEL=
AI_TEMPERATURE=
AI_MAX_TOKENS=
`;

const SH_ALIASES_TEMPLATE = `# Add your custom aliases here.
# This file is loaded automatically by your shell.
#
# Examples:
#   alias gs='git status'
#   alias tyr-deploy='tyr deploy'
`;

const SH_PLUGINS_TEMPLATE = `# Add your shell plugins here.
# Compatible with zsh, bash and other POSIX shells.
#
# Examples (zsh):
#   source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
`;

const PS_ALIASES_TEMPLATE = `# Add your custom aliases for PowerShell here.
#
# Examples:
#   Set-Alias gs git-status
#   function tyr-deploy { tyr deploy @args }
`;

const PS_PLUGINS_TEMPLATE = `# Add your PowerShell modules and plugins here.
#
# Examples:
#   Import-Module posh-git
#   Import-Module PSReadLine
`;

const GIT_IGNORE = `# ENVIRONMENT
.env

# NODE 
node_modules
`;

function makeTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function configureUnixShell(tyrFs: any, logger: any, homeDir: string, aliasesPath: string, pluginsPath: string): Promise<void> {
    const rcFile = detectShellRcFile(homeDir);
    if (!rcFile) {
        logger.warn('Could not detect shell configuration file.');
        logger.info(`Add manually:\n  source "${aliasesPath}"\n  source "${pluginsPath}"`);
        return;
    }
    await tyrFs.ensureLine(rcFile, `source "${aliasesPath}"`);
    await tyrFs.ensureLine(rcFile, `source "${pluginsPath}"`);
    logger.success(`Shell configured: ${rcFile}`);
    logger.info(`Run: source ${rcFile}  (or open a new terminal)`);
}

async function configureWindowsShell(tyrFs: any, logger: any, shell: any, aliasesPath: string, pluginsPath: string): Promise<void> {
    const profiles = getWindowsProfilePaths();

    if (profiles.length === 0) {
        logger.warn('Could not detect PowerShell profile (USERPROFILE is not defined).');
        logger.info(`Add manually:\n  . "${aliasesPath}"\n  . "${pluginsPath}"`);
        return;
    }

    for (const psProfile of profiles) {
        await tyrFs.createDir(path.dirname(psProfile));

        await tyrFs.ensureLine(psProfile, `. "${aliasesPath}"`);
        await tyrFs.ensureLine(psProfile, `. "${pluginsPath}"`);
        logger.success(`PowerShell profile configured: ${psProfile}`);
    }

    logger.info('Restart PowerShell (or open a new console) to apply the changes.');

    await checkWindowsExecutionPolicy(shell, logger);
}

/**
 * @method config (default export)
 * @description Bootstraps `~/.tyr`. Always backs up an existing `~/.tyr` first (timestamped
 * `.bak.<ts>` copy, logs excluded). If `--repo <url>` is given, clones that repo over `~/.tyr`;
 * if the clone already contains a `map.yml`, its content is used as-is (nothing below is
 * generated). Otherwise (no repo, or an empty one), writes the default templates
 * (`aliases`/`plugins`/`map.yml`/`imported_modules.yaml`/`.env.example`/`.gitignore`/
 * `package.json`/`tsconfig.json`), runs `npm install` inside `~/.tyr` so the generated
 * `tsconfig.json`'s types resolve, and — if `--repo` was given — commits and pushes that initial
 * configuration back to the new repo. Finally configures the user's shell (or PowerShell profile
 * on Windows) to `source`/dot-source the `aliases`/`plugins` files.
 * @param {TyrContext} context - Uses `logger`, `fs`, `frameworkRoot`, `shell`.
 * @returns {(args: string[]) => Promise<void>} Handler expecting `args = [--repo <url>?]`.
 * @example
 * // tyr --config
 * // tyr --config --repo git@github.com:team/tyr-config.git
 */
export default function config({ logger, fs: tyrFs, frameworkRoot, shell }: TyrContext) {
    return async (args: string[]) => {
        const homeDir = homedir();
        const userRoot = path.join(homeDir, '.tyr');
        const isWindows = platform() === 'win32';
        const ext = isWindows ? '.ps1' : '';

        // Parse --repo <url>
        const repoIndex = args.indexOf('--repo');
        const repoUrl = repoIndex !== -1 ? (args[repoIndex + 1] ?? null) : null;

        if (repoIndex !== -1 && (!repoUrl || repoUrl.startsWith('--'))) {
            logger.error('Repository URL is missing.');
            logger.info('Usage: tyr --config --repo <url>');
            return;
        }

              let backupPath: string | null = null;
        if (existsSync(userRoot)) {
            backupPath = `${userRoot}.bak.${makeTimestamp()}`;
            backupUserRoot(userRoot, backupPath);
            logger.warn(`Previous configuration backed up at: ${backupPath}`);
        }

               let repoHasContent = false;
        if (repoUrl) {
            const tempDir = `${userRoot}.setup-temp`;
            if (existsSync(tempDir)) {
                try { removeDirRecursive(tempDir); } catch {}
            }

            logger.info(`\nCloning repository: ${repoUrl}`);
            try {
                await shell.exec(`git clone "${repoUrl}" "${tempDir}"`);
            } catch (e) {
                if (existsSync(tempDir)) {
                    try { removeDirRecursive(tempDir); } catch {}
                }
                throw e;
            }

            repoHasContent = existsSync(path.join(tempDir, 'map.yml'));
            logger.success(repoHasContent
                ? 'Repository cloned with existing configuration.'
                : 'Empty repository — starting default configuration...');

            clearDirExceptLogs(userRoot);
            copyDirContents(tempDir, userRoot);
            try { removeDirRecursive(tempDir); } catch {}
        }

        if (!repoHasContent) {
            logger.info('\nInitializing ~/.tyr...\n');

            await tyrFs.createDir(path.join(userRoot, 'commands'));
            logger.success(`Directory created: ${path.join(userRoot, 'commands')}`);

            const aliasesPath = path.join(userRoot, `aliases${ext}`);
            if (!tyrFs.exists(aliasesPath)) {
                await tyrFs.write(aliasesPath, isWindows ? PS_ALIASES_TEMPLATE : SH_ALIASES_TEMPLATE);
                logger.success(`File created: ${aliasesPath}`);
            }

            const pluginsPath = path.join(userRoot, `plugins${ext}`);
            if (!tyrFs.exists(pluginsPath)) {
                await tyrFs.write(pluginsPath, isWindows ? PS_PLUGINS_TEMPLATE : SH_PLUGINS_TEMPLATE);
                logger.success(`File created: ${pluginsPath}`);
            }

            const mapPath = path.join(userRoot, 'map.yml');
            await tyrFs.write(mapPath, 'commands: {}\n');
            logger.success(`File created: ${mapPath}`);

            const importedModulesPath = path.join(userRoot, 'imported_modules.yaml');
            await tyrFs.write(importedModulesPath, 'modules: {}\n');
            logger.success(`File created: ${importedModulesPath}`);

            const envPath = path.join(userRoot, '.env.example');
            if (!tyrFs.exists(envPath)) {
                await tyrFs.write(envPath, ENV_TEMPLATE);
                logger.success(`File created: ${envPath}`);
            }
            
            const gitignorePath = path.join(userRoot, '.gitignore');
            if (!tyrFs.exists(gitignorePath)) {
                await tyrFs.write(gitignorePath, GIT_IGNORE);
                logger.success(`File created: ${gitignorePath}`);
            }

            const packageJsonPath = path.join(userRoot, 'package.json');
            if (!tyrFs.exists(packageJsonPath)) {
                await tyrFs.write(packageJsonPath, PACKAGE_JSON_TEMPLATE);
                logger.success(`File created: ${packageJsonPath}`);
            }

            const tsconfigPath = path.join(userRoot, 'tsconfig.json');
            if (!tyrFs.exists(tsconfigPath)) {
                await tyrFs.write(tsconfigPath, TSCONFIG_TEMPLATE);
                logger.success(`File created: ${tsconfigPath}`);
            }

            logger.info('\nInstalling type dependencies in ~/.tyr...');
            shell.cd(userRoot);
            try {
                await shell.exec('npm install');
                logger.success('Dependencies installed successfully.');
            } catch {
                logger.warn('Could not run npm install in ~/.tyr. Run it manually.');
            }

            if (repoUrl) {
                logger.info('\nPushing initial configuration to repository...');
                shell.cd(userRoot);
                try {
                    await shell.exec('git add .');
                    await shell.exec('git commit -m "Initial tyr configuration"');
                    await shell.exec('git push -u origin HEAD');
                    logger.success('Configuration pushed to repository.');
                } catch (e) {
                    logger.warn('Could not push automatically. Do it manually from ~/.tyr');
                }
            }
        }

        const importedModulesPath = path.join(userRoot, 'imported_modules.yaml');
        if (!tyrFs.exists(importedModulesPath)) {
            await tyrFs.write(importedModulesPath, 'modules: {}\n');
            logger.success(`File created: ${importedModulesPath}`);
        }

        const packageJsonPath = path.join(userRoot, 'package.json');
        const tsconfigPath    = path.join(userRoot, 'tsconfig.json');
        let needsInstall = false;

        if (!tyrFs.exists(packageJsonPath)) {
            await tyrFs.write(packageJsonPath, PACKAGE_JSON_TEMPLATE);
            logger.success(`File created: ${packageJsonPath}`);
            needsInstall = true;
        }

        if (!tyrFs.exists(tsconfigPath)) {
            await tyrFs.write(tsconfigPath, TSCONFIG_TEMPLATE);
            logger.success(`File created: ${tsconfigPath}`);
            needsInstall = true;
        }

        if (needsInstall) {
            logger.info('\nInstalling type dependencies in ~/.tyr...');
            shell.cd(userRoot);
            try {
                await shell.exec('npm install');
                logger.success('Dependencies installed.');
            } catch {
                logger.warn('Could not run npm install in ~/.tyr. Run it manually.');
            }
        }

        const aliasesPath = path.join(userRoot, `aliases${ext}`);
        const pluginsPath = path.join(userRoot, `plugins${ext}`);

        if (tyrFs.exists(aliasesPath) || tyrFs.exists(pluginsPath)) {
            logger.info('\nConfiguring shell...');
            if (isWindows) {
                await configureWindowsShell(tyrFs, logger, shell, aliasesPath, pluginsPath);
            } else {
                await configureUnixShell(tyrFs, logger, homeDir, aliasesPath, pluginsPath);
            }
        }

        logger.success('\nTyr configured successfully.');
        logger.info(`Configuration directory: ${userRoot}`);
        if (repoUrl) logger.info(`Linked repository: ${repoUrl}`);
        logger.info('\nNext steps:');
        logger.info('  tyr gen <name> <file>   Create a new command');
        logger.info('  tyr doc                 View API documentation');
    };
}
