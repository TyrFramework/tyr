/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.docker`. A thin, {@link ShellManager}-backed wrapper around the
 * `docker`/`docker-compose` CLIs — there is no Docker SDK dependency here, every operation is a
 * shelled-out `docker ...` command whose output is parsed or its exit code checked.
 */
import { ShellManager } from './ShellManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

export interface DockerRunOptions {
    image: string;
    name: string;
    port?: string;
    env?: string[];
}

/**
 * @class DockerManager
 * @description Low-level manager for interacting with the Docker Daemon.
 * Allows starting individual containers, checking states, and managing Docker Compose stacks.
 */
export class DockerManager {
    private shell: ShellManager;
    private logger: Logger;

    constructor(shell: ShellManager, logger: Logger) {
        this.shell = shell;
        this.logger = logger;
    }

    /**
     * @method isRunning
     * @description Checks whether the Docker service is active and responding on the host system.
     * @returns {Promise<boolean>} True if Docker is running.
     * @example
     * const active = await docker.isRunning();
     * if (!active) fail('Start Docker first.');
     */
    public async isRunning(): Promise<boolean> {
        try {
            await this.shell.exec('docker info');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * @method run
     * @description Deploys an individual container in detached mode. If it already exists, restarts it.
     * @param {DockerRunOptions} config - Deployment configuration.
     * @example
     * await docker.run({ name: 'my-db', image: 'mongo:latest', port: '27017:27017' });
     */
    public async run({ image, name, port, env = [] }: DockerRunOptions): Promise<void> {
        this.logger.info(`Starting container: ${name} (${image})...`);
        try {
            if (await this.containerExists(name)) {
                this.logger.warn(`Container ${name} already exists. Restarting...`);
                await this.shell.exec(`docker rm -f ${name}`);
            }

            const envFlags = env.map(e => `-e ${e}`).join(' ');
            const portMapping = port ? `-p ${port}` : '';
            const containerId = await this.shell.exec(`docker run -d --name ${name} ${portMapping} ${envFlags} ${image}`);
            this.logger.success(`Container active. ID: ${containerId.substring(0, 12)}`);
        } catch (e) {
            if (e instanceof TyrError) throw e;
            throw new TyrError(`Could not start container: ${name}`, e, 'Check that Docker is running and the image exists.');
        }
    }

    /**
     * @method containerExists
     * @description Checks whether a specific container exists (running or stopped).
     * @param {string} name - The container name to look for.
     * @returns {Promise<boolean>} True if it exists.
     * @example
     * if (await docker.containerExists('my-app')) { ... }
     */
    public async containerExists(name: string): Promise<boolean> {
        try {
            await this.shell.exec(`docker inspect ${name}`);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * @method composeUp
     * @description Starts a full stack using a docker-compose file.
     * @param {string} file - Relative path to the compose file.
     * @example
     * await docker.composeUp('infrastructure/db-compose.yml');
     */
    public async composeUp(file: string = 'docker-compose.yml'): Promise<void> {
        this.logger.info(`Starting stack from ${file}...`);
        try {
            await this.shell.exec(`docker-compose -f ${file} up -d`);
            this.logger.success('Stack deployed successfully.');
        } catch (e) {
            if (e instanceof TyrError) throw e;
            throw new TyrError(`Could not start Docker Compose stack from: ${file}`, e, 'Check that the compose file exists and is valid.');
        }
    }
}

export const DockerManagerTests = {
    // isRunning: {},
    // run: { image: 'alpine:latest', name: 'tyr-test-container', env: [] },
    // containerExists: { name: 'tyr-test-container' },
};
