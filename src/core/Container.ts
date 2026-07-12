/**
 * @fileoverview The dependency-injection container: the piece of Kernel → Container → TyrContext
 * → Commands that turns a flat list of Manager classes (src/lib/*.ts) into the single object every
 * command receives. `Kernel.boot()` creates one `Container` and calls `init()` exactly once per
 * process, wiring each Manager's own constructor dependencies (e.g. `GitManager` needs a
 * `ShellManager` and a `Logger`) by hand in `init()`'s instantiation order below. `Kernel.handle()`
 * then calls `get()` and spreads the result into every {@link TyrContext} it builds — so a Manager
 * is only ever constructed once per process, no matter how many commands run via `TyrContext.run()`
 * composition. Adding a new Manager means: import it here, add it to {@link ServiceContainer}, and
 * instantiate it in `init()` (in dependency order — see the existing entries for the pattern).
 */
import { ShellManager } from '../lib/ShellManager.js';
import { FileSystemManager } from '../lib/FileSystemManager.js';
import { PackageManager } from '../lib/PackageManager.js';
import { DockerManager } from '../lib/DockerManager.js';
import { GitManager } from '../lib/GitManager.js';
import { SystemManager } from '../lib/SystemManager.js';
import { SQLManager } from '../lib/SQLManager.js';
import { MongoManager } from '../lib/MongoManager.js';
import { WebManager } from '../lib/WebManager.js';
import { WorkspaceManager } from '../lib/WorkspaceManager.js';
import { JiraManager } from '../lib/JiraManager.js';
import { SetupManager } from '../lib/SetupManager.js';
import { AIVendorManager } from '../lib/AIVendorManager.js';
import { AIContextManager } from '../lib/AIContextManager.js';
import { SandboxManager } from '../lib/SandboxManager.js';
import { MemoryManager } from '../lib/MemoryManager.js';
import { PromptTemplateManager } from '../lib/PromptTemplateManager.js';
import { TokenManager } from '../lib/TokenManager.js';
import { ChatManager } from '../lib/ChatManager.js';
import { Logger, createLogger } from './Logger.js';

import path from 'path';

export type { Logger };

/**
 * Every Manager instance the Container produces, keyed by the name it is exposed under in
 * {@link TyrContext} (e.g. `context.git` is a `GitManager`). This is the authoritative list of
 * "what a command can destructure from its context" beyond the framework-level members
 * (`frameworkRoot`, `run`, `task`, `fail`, ...) that {@link Kernel.handle} adds itself.
 */
export interface ServiceContainer {
    logger: Logger;
    path: typeof path;
    shell: ShellManager;
    fs: FileSystemManager;
    pkg: PackageManager;
    docker: DockerManager;
    git: GitManager;
    sys: SystemManager;
    db: SQLManager;
    mongo: MongoManager;
    web: WebManager;
    workspace: WorkspaceManager;
    jira: JiraManager;
    setup: SetupManager;
    aiVendor: AIVendorManager;
    aiContext: AIContextManager;
    sandbox: SandboxManager;
    memory: MemoryManager;
    prompts: PromptTemplateManager;
    tokens: TokenManager;
    chat: ChatManager;
}

/**
 * @class Container
 * @description Holds and constructs every Manager exactly once per process. `services` is
 * `Partial<ServiceContainer>` (rather than `ServiceContainer`) purely to represent the brief
 * window between construction and `init()`; `get()` is what upgrades that back to a fully-typed,
 * guaranteed-populated `ServiceContainer` for callers.
 */
export class Container {
    private services: Partial<ServiceContainer>;

    constructor() {
        this.services = {};
    }

    /**
     * @method init
     * @description Instantiates every Manager and wires their constructor dependencies by hand
     * (e.g. `AIContextManager` needs `fs`, `shell`, `aiVendor`, `logger`, `git` and `sandbox`, all
     * constructed just above it). Must be called once, before `get()` — `Kernel.boot()` is the only
     * caller. Not async despite `Kernel.boot()` awaiting it: no Manager constructor currently does
     * I/O, so this is effectively synchronous today; the `await` in Kernel is there so adding
     * async setup later (e.g. a Manager that pings a service on startup) wouldn't require a call-site
     * change.
     * @param {boolean} isDebug - Whether `--debug` was passed; controls the Logger's verbosity.
     * @example
     * const container = new Container();
     * await container.init(false);
     */
    public init(isDebug: boolean): void {
        const logger = createLogger(isDebug);
        const shell = new ShellManager();
        const db = new SQLManager();
        const mongo = new MongoManager();
        const web = new WebManager(logger);
        const fs = new FileSystemManager(logger);
        const aiVendor = new AIVendorManager(logger);
        const git = new GitManager(shell, logger);
        const sandbox = new SandboxManager(logger);
        const aiContext = new AIContextManager(fs, shell, aiVendor, logger, git, sandbox);

        this.services = {
            logger,
            path,
            shell,
            db,
            mongo,
            web,
            fs,
            pkg: new PackageManager(shell, logger),
            docker: new DockerManager(shell, logger),
            git,
            sys: new SystemManager(shell, logger),
            workspace: new WorkspaceManager(shell, fs, logger),
            jira: new JiraManager(web, shell, logger),
            setup: new SetupManager(shell, fs, logger),
            aiVendor,
            aiContext,
            sandbox,
            memory: new MemoryManager(fs, logger),
            prompts: new PromptTemplateManager(aiContext, logger),
            tokens: new TokenManager(logger),
            chat: new ChatManager(fs, logger),
        };
    }

    /**
     * @method get
     * @description Returns the fully-constructed service container. Throws if called before
     * `init()` (detected via the always-present `logger` field), so a missing `init()` call fails
     * loudly at the first Manager access instead of silently handing out `undefined` Managers.
     * @returns {ServiceContainer} Every Manager instance, keyed as in {@link ServiceContainer}.
     * @example
     * const { shell, git, logger } = container.get();
     */
    public get(): ServiceContainer {
        if (!this.services.logger) {
            throw new Error('Container not initialised. Call .init() first.');
        }
        return this.services as ServiceContainer;
    }
}
