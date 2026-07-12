/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.setup`. Higher-level than {@link PackageManager}: this is aimed
 * specifically at bootstrapping a *cloned repository*'s local dev environment (detecting its
 * docker-compose setup, installing compose/buildx if missing, generating a `Makefile` of
 * shortcuts) rather than installing arbitrary system packages.
 */
import path from 'path';
import { ShellManager } from './ShellManager.js';
import { FileSystemManager } from './FileSystemManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

/**
 * @class SetupManager
 * @description Utilities for bootstrapping a development environment from a
 * remote repository. Covers OS detection, dependency checks, docker-compose
 * introspection, compose/buildx installation, Makefile generation, and
 * migration-strategy detection.
 */
export class SetupManager {
    private shell: ShellManager;
    private fs: FileSystemManager;
    private logger: Logger;

    constructor(shell: ShellManager, fs: FileSystemManager, logger: Logger) {
        this.shell = shell;
        this.fs    = fs;
        this.logger = logger;
    }

    // ── OS / package manager ────────────────────────────────────────────────

    /**
     * @method detectPkgMgr
     * @description Detects the system package manager including apk (Alpine Linux).
     * Checks: apk → apt → brew → dnf on Unix; winget → choco → scoop on Windows.
     * @returns {Promise<string>} Manager name ('apk','apt','brew','dnf','winget',
     *   'choco','scoop') or 'unknown' if none found.
     * @example
     * const mgr = await setup.detectPkgMgr();
     * logger.info(`Package manager: ${mgr}`);
     */
    public async detectPkgMgr(): Promise<string> {
        const candidates: [string, string][] =
            process.platform === 'win32'
                ? [['winget', 'winget'], ['choco', 'choco'], ['scoop', 'scoop']]
                : [['apk', 'apk'], ['apt-get', 'apt'], ['brew', 'brew'], ['dnf', 'dnf']];

        for (const [bin, name] of candidates) {
            const found = await this.shell.exec(`which ${bin} >/dev/null 2>&1`)
                .then(() => true).catch(() => false);
            if (found) return name;
        }
        return 'unknown';
    }

    /**
     * @method sysInstall
     * @description Installs a system-level package using the detected package manager.
     * @param {string} pkgMgr - Package manager name as returned by detectPkgMgr().
     * @param {string} pkg - Package name to install (e.g. 'git', 'nodejs', 'docker').
     * @example
     * await setup.sysInstall('apk', 'git');
     */
    public async sysInstall(pkgMgr: string, pkg: string): Promise<void> {
        const cmds: Record<string, string> = {
            apk:    `apk add --no-cache ${pkg}`,
            apt:    `apt-get install -y ${pkg}`,
            brew:   `brew install ${pkg}`,
            dnf:    `sudo dnf install -y ${pkg}`,
            winget: `winget install ${pkg}`,
            choco:  `choco install -y ${pkg}`,
            scoop:  `scoop install ${pkg}`,
        };
        const cmd = cmds[pkgMgr];
        if (!cmd) throw new TyrError(`Unsupported package manager: ${pkgMgr}`);
        try {
            await this.shell.exec(cmd);
        } catch (e) {
            throw new TyrError(`Could not install package '${pkg}' with ${pkgMgr}.`, e, `Run the install command manually: ${cmd}`);
        }
    }

    /**
     * @method binExists
     * @description Checks whether a binary is available on PATH.
     * @param {string} bin - Binary name to look for (e.g. 'git', 'docker').
     * @returns {Promise<boolean>} True if the binary is found.
     * @example
     * if (!await setup.binExists('docker')) fail('Docker is required.');
     */
    public async binExists(bin: string): Promise<boolean> {
        return this.shell.exec(`which ${bin} >/dev/null 2>&1`)
            .then(() => true).catch(() => false);
    }

    // ── docker-compose file introspection ───────────────────────────────────

    /**
     * @method findComposeFile
     * @description Locates a docker-compose file in the given directory.
     * Checks: docker-compose.yml, docker-compose.yaml,
     *   docker-compose.override.yml, compose.yml, compose.yaml.
     * @param {string} dir - Directory to search in.
     * @returns {string|null} Absolute path of the compose file, or null.
     * @example
     * const file = setup.findComposeFile('/path/to/repo');
     * if (!file) logger.warn('No compose file found.');
     */
    public findComposeFile(dir: string): string | null {
        const candidates = [
            'docker-compose.yml',
            'docker-compose.yaml',
            'docker-compose.override.yml',
            'compose.yml',
            'compose.yaml',
        ];
        for (const f of candidates) {
            const full = path.join(dir, f);
            if (this.fs.exists(full)) return full;
        }
        return null;
    }

    /**
     * @method extractPorts
     * @description Extracts unique host ports from a docker-compose file.
     * Handles all four YAML port formats:
     *   - "HOST:CONTAINER"  (quoted or unquoted)
     *   - HOST:CONTAINER    (numeric pair)
     *   - PORT              (single plain number)
     *   - published: PORT   (long-form mapping)
     * @param {string} composeFile - Absolute path to the compose file.
     * @returns {Promise<number[]>} Sorted list of unique host port numbers.
     * @example
     * const ports = await setup.extractPorts('/repo/docker-compose.yml');
     * // [3000, 5432, 8080]
     */
    public async extractPorts(composeFile: string): Promise<number[]> {
        const portSet = new Set<number>();

        const addPorts = (raw: string) => {
            for (const line of raw.split('\n')) {
                const n = parseInt(line.trim(), 10);
                if (!isNaN(n) && n > 0) portSet.add(n);
            }
        };

        // Format 1+2: - "HOST:CONTAINER" or - HOST:CONTAINER
        addPorts(await this.shell.exec(
            `grep -E '^\\s*-\\s+"?[0-9]+:[0-9]+"?' "${composeFile}" 2>/dev/null | grep -oE '[0-9]+:[0-9]+' | cut -d: -f1 || true`
        ).catch(() => ''));

        // Format 3: - PORT (single number)
        addPorts(await this.shell.exec(
            `grep -E '^\\s*-\\s+"?[0-9]+"?\\s*$' "${composeFile}" 2>/dev/null | grep -oE '[0-9]+' || true`
        ).catch(() => ''));

        // Format 4: published: PORT
        addPorts(await this.shell.exec(
            `grep -E '^\\s+published:\\s*[0-9]+' "${composeFile}" 2>/dev/null | grep -oE '[0-9]+' || true`
        ).catch(() => ''));

        return Array.from(portSet).sort((a, b) => a - b);
    }

    /**
     * @method getAppService
     * @description Detects the main application service in a docker-compose file.
     * Tries preferred names first (app, web, backend, api, server, worker),
     * then falls back to the first service defined.
     * @param {string} composeFile - Absolute path to the compose file.
     * @returns {Promise<string>} Service name, or empty string if not found.
     * @example
     * const svc = await setup.getAppService('/repo/docker-compose.yml');
     * // 'api'
     */
    public async getAppService(composeFile: string): Promise<string> {
        const preferred = ['app', 'web', 'backend', 'api', 'server', 'worker'];
        for (const svc of preferred) {
            const r = await this.shell.exec(
                `grep -qE "^  ${svc}:" "${composeFile}" 2>/dev/null && echo yes || echo no`
            ).catch(() => 'no');
            if (r.trim() === 'yes') return svc;
        }
        const first = await this.shell.exec(
            `grep -E "^  [a-zA-Z]" "${composeFile}" 2>/dev/null | head -1 | sed 's/://;s/^[[:space:]]*//'`
        ).catch(() => '');
        return first.trim();
    }

    // ── docker compose / buildx installation ────────────────────────────────

    /**
     * @method getComposeCmd
     * @description Resolves the available docker compose command.
     * Prefers the compose plugin ('docker compose'), falls back to the
     * standalone binary ('docker-compose'), and installs it from GitHub
     * (or pip as a last resort) if neither is found.
     * @returns {Promise<string|null>} Command string, or null if unavailable.
     * @example
     * const cmd = await setup.getComposeCmd();
     * if (!cmd) fail('docker compose is required.');
     */
    public async getComposeCmd(): Promise<string | null> {
        const pluginOk = await this.shell.exec('docker compose version 2>/dev/null')
            .then(() => true).catch(() => false);
        if (pluginOk) return 'docker compose';

        if (await this.binExists('docker-compose')) return 'docker-compose';

        this.logger.warn('docker-compose not found. Attempting to install...');

        const rawArch = await this.shell.exec('uname -m').catch(() => 'x86_64');
        const osName  = await this.shell.exec("uname -s | tr '[:upper:]' '[:lower:]'").catch(() => 'linux');
        const bin     = '/usr/local/bin/docker-compose';
        const url     = `https://github.com/docker/compose/releases/latest/download/docker-compose-${osName.trim()}-${rawArch.trim()}`;

        this.logger.info('Downloading docker-compose from GitHub...');
        try {
            await this.shell.exec(`curl -fsSL "${url}" -o "${bin}" && chmod +x "${bin}"`);
            if (await this.shell.exec('docker-compose version 2>/dev/null').then(() => true).catch(() => false)) {
                this.logger.success('docker-compose installed successfully.');
                return 'docker-compose';
            }
        } catch { /* fall through to pip */ }

        const pip = await this.shell.exec('which pip3 2>/dev/null || which pip 2>/dev/null').catch(() => '');
        if (pip.trim()) {
            try {
                await this.shell.exec(
                    `${pip.trim()} install --quiet docker-compose --break-system-packages 2>/dev/null || ${pip.trim()} install --quiet docker-compose`
                );
                if (await this.binExists('docker-compose')) {
                    this.logger.success('docker-compose installed via pip.');
                    return 'docker-compose';
                }
            } catch { /* fall through */ }
        }

        this.logger.warn('Could not install docker-compose automatically.');
        this.logger.warn('Install it manually: https://docs.docker.com/compose/install/');
        return null;
    }

    /**
     * @method ensureBuildx
     * @description Installs the docker buildx plugin if it is not already available.
     * Fetches the latest release URL dynamically from the GitHub API.
     * @example
     * await setup.ensureBuildx();
     */
    public async ensureBuildx(): Promise<void> {
        const ok = await this.shell.exec('docker buildx version 2>/dev/null')
            .then(() => true).catch(() => false);
        if (ok) return;

        this.logger.info('Installing docker buildx plugin...');
        const rawArch   = await this.shell.exec('uname -m').catch(() => 'x86_64');
        const arch      = rawArch.trim().replace('x86_64', 'amd64').replace('aarch64', 'arm64');
        const osName    = await this.shell.exec("uname -s | tr '[:upper:]' '[:lower:]'").catch(() => 'linux');
        const pluginDir = '/usr/local/lib/docker/cli-plugins';

        const urlRaw = await this.shell.exec(
            `wget -qO- https://api.github.com/repos/docker/buildx/releases/latest ` +
            `| grep "browser_download_url" | grep '"${osName.trim()}-${arch}"' | cut -d'"' -f4 || true`
        ).catch(() => '');

        if (!urlRaw.trim()) {
            this.logger.warn('Could not fetch the docker buildx URL. The build may show warnings.');
            return;
        }
        try {
            await this.shell.exec(
                `mkdir -p "${pluginDir}" && wget -qO "${pluginDir}/docker-buildx" "${urlRaw.trim()}" && chmod +x "${pluginDir}/docker-buildx"`
            );
            this.logger.success('docker buildx installed.');
        } catch {
            this.logger.warn('Could not install docker buildx. The build may show warnings.');
        }
    }

    // ── Makefile generation ─────────────────────────────────────────────────

    /**
     * @method generateMakefile
     * @description Creates a Makefile with docker compose shortcuts in the repo
     * directory. If a Makefile already exists, writes Makefile.dev instead.
     * Does nothing if the target file is already present.
     * @param {string} repoDir - Absolute path to the cloned repository.
     * @example
     * await setup.generateMakefile('/workspace/my-repo');
     */
    public async generateMakefile(repoDir: string): Promise<void> {
        const hasExisting  = this.fs.exists(path.join(repoDir, 'Makefile'));
        const makefileName = hasExisting ? 'Makefile.dev' : 'Makefile';
        const makefilePath = path.join(repoDir, makefileName);
        const invokePrefix = hasExisting ? 'make -f Makefile.dev' : 'make';

        if (this.fs.exists(makefilePath)) {
            this.logger.info(`${makefileName} already exists. Skipping.`);
            return;
        }

        const TAB = '\t';
        const content = [
            `# ${makefileName} generated by setup-dev`,
            '',
            'up:',      TAB + 'docker-compose up -d',                '',
            'build:',   TAB + 'docker-compose up -d --build',        '',
            'stop:',    TAB + 'docker-compose down --remove-orphans', '',
            'restart:', TAB + 'docker-compose restart',               '',
            'logs:',    TAB + 'docker-compose logs -f',               '',
            'ps:',      TAB + 'docker-compose ps',                    '',
        ].join('\n');

        await this.fs.write(makefilePath, content);
        this.logger.success(`${makefileName} generated at: ${makefilePath}`);
        this.logger.info(`  ${invokePrefix} up      -> start containers`);
        this.logger.info(`  ${invokePrefix} build   -> rebuild and start`);
        this.logger.info(`  ${invokePrefix} stop    -> stop and remove (no orphans)`);
        this.logger.info(`  ${invokePrefix} logs    -> watch logs in real time`);
        this.logger.info(`  ${invokePrefix} ps      -> container status`);
    }
}

export const SetupManagerTests = {
    detectPkgMgr: {},
    binExists: { bin: 'git' },
    findComposeFile: { dir: '/tmp' },
};
