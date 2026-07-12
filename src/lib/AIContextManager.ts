/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.aiContext`. The heart of Tyr's AI coding-assistant stack: owns
 * finding/generating a project's guideline file (AGENTS.md/CLAUDE.md), the tool-using agent loop
 * that lets a model explore a project on its own via {@link AGENT_TOOLS}, the Search/Replace patch
 * engine that applies a model's edits safely (never overwriting a file it hasn't actually seen —
 * see `seenFiles` in `AgentToolContext`), and post-write validation/self-healing. Depends on
 * {@link FileSystemManager}, {@link ShellManager}, {@link GitManager}, {@link SandboxManager} and
 * {@link AIVendorManager} (injected in `Container.init()`) rather than importing any of them as
 * globals, so it can be constructed with test doubles.
 *
 * Intended usage: a command (none of which currently ship in this repository — see this file's
 * own comments referencing an "ai:code"/"ai:describe" command, and doc.ts's `run('ai', ...)` call)
 * builds a prompt via {@link PromptTemplateManager}, then calls `runCodeAgent()`/
 * `runDescribeAgent()` on this class and reports the result.
 */
import path from 'path';
import { statSync } from 'fs';
import { createPatch } from 'diff';

import { FileSystemManager } from './FileSystemManager.js';
import { ShellManager } from './ShellManager.js';
import { GitManager } from './GitManager.js';
import { SandboxManager, SandboxResult } from './SandboxManager.js';
import { AIVendorManager, AIMessage, AIContentBlock, AITool, TaskPriority } from './AIVendorManager.js';
import { TokenManager } from './TokenManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

import { getEnvInt } from '../core/util/getenv.js';

// --- Context files (CLAUDE.md / AGENTS.md style guidelines) --------------------------------------

const CONTEXT_FILENAMES = [
    'CLAUDE.md',
    'AGENTS.md',
    'CONTEXT.md',
    'README.md',
    '.cursorrules',
    path.join('.github', 'copilot-instructions.md'),
];

const GENERATED_FILENAME = 'CLAUDE.md';

const SNAPSHOT_TREE_MAX_DEPTH = getEnvInt('SNAPSHOT_TREE_MAX_DEPTH', 5);
const SNAPSHOT_TREE_MAX_ENTRIES_PER_DIR = getEnvInt('SNAPSHOT_TREE_MAX_ENTRIES_PER_DIR', 250);
const SNAPSHOT_SECTION_MAX_CHARS = getEnvInt('SNAPSHOT_SECTION_MAX_CHARS', 40000);

// How far findContextFiles() looks for guideline files OUTSIDE the exact target directory: upward
// into ancestor directories (toward the repo root — a monorepo root AGENTS.md still applies to a
// package inside it) and downward into subdirectories (a nested package may document itself).
// Both are bounded so a huge repo doesn't turn every command into a full filesystem crawl.
const CONTEXT_SEARCH_UPWARD_LEVELS = getEnvInt('CONTEXT_SEARCH_UPWARD_LEVELS', 4);
const CONTEXT_SEARCH_DOWNWARD_LEVELS = getEnvInt('CONTEXT_SEARCH_DOWNWARD_LEVELS', 3);
// Cap on how many context files are actually used, once found — closest to `dir` wins. Keeps a
// monorepo with many nested AGENTS.md files from flooding the prompt with everything it can reach.
const MAX_CONTEXT_FILES = getEnvInt('MAX_CONTEXT_FILES', 6);

const DEFAULT_IGNORED_DIRS = new Set<string>([
    'node_modules', '.git', '.hg', '.svn',
    '.turbo', '.next', '.nuxt', '.cache', '.parcel-cache',
    '.vscode', '.idea',
    'dist', 'build', 'out', 'coverage', '.nyc_output',
    'target', 'vendor',
]);

const PACKAGE_JSON_FIELDS = ['name', 'version', 'type', 'dependencies', 'devDependencies', 'scripts'] as const;

const GUIDELINES_SYSTEM_PROMPT =
    'You are a senior software architect. Given a snapshot of a project (package manifest, README ' +
    'and file structure), produce a concise, well-structured Markdown file of coding guidelines and ' +
    'project conventions (stack, architecture, naming, testing, error handling) meant to be read by ' +
    'an AI coding assistant before making changes. Be specific to this project and avoid generic ' +
    'advice. Output only the Markdown content, with no surrounding commentary.';

interface GuidelinesBlock {
    fileName: string;
    content: string;
}

// --- Agentic exploration (tool use) ---------------------------------------------------------------
//
// Everything below powers the tool-use agent loop shared by ai:code and ai:describe: the model is
// seeded with only a tree + AGENTS.md, and pulls in anything else (a specific file, a directory
// listing, a dependency's real source) itself via these tools, instead of the command layer trying
// to guess what's relevant ahead of time (see runAgentLoop / AGENT_TOOLS).

const AGENTS_MD_FILENAME = 'AGENTS.md';
const MANIFEST_FILENAMES = new Set(['package.json', 'composer.json']);
const README_PATTERN = /^readme(\.[a-z0-9]+)?$/i;

const READABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.md', '.yml', '.yaml',
    '.py', '.go', '.rb', '.php', '.java', '.rs',
    '.sh',
]);

const TREE_MAX_ENTRIES_PER_DIR = 200;

// How many levels upward from the starting directory we search for a repo root (marked by a .git
// folder) to decide how far the model's READ-ONLY exploration tools can reach. Does not affect
// where WRITES are allowed — that stays confined to the target directory (see applyPatches).
const MAX_UPWARD_SEARCH_LEVELS = 4;

const MAX_TOOL_RESULT_CHARS = 12000;
const MAX_DEPENDENCY_MATCHES = 25;
const DEFAULT_MAX_AGENT_ITERATIONS = 6;

// Deliberately more lenient than DEFAULT_IGNORED_DIRS when listing inside an installed dependency:
// "dist/build" is generated noise in the project itself, but it's exactly the real, compiled code
// that needs reading inside node_modules.
const PACKAGE_IGNORED_DIRS = new Set<string>(['node_modules', '.git', '.hg', '.svn', '.github', 'coverage', '.nyc_output']);

// How many levels upward, from the project directory, we search for node_modules/<package>.
// Deliberately more generous than MAX_UPWARD_SEARCH_LEVELS: mimics real Node.js module
// resolution, which can land above the repo root in hoisted monorepos.
const NODE_MODULES_SEARCH_MAX_LEVELS = 15;

// Loop Detector: abort the agent loop if the same tool is called with identical arguments this
// many times in a row, to avoid infinite loops and token draining.
const LOOP_DETECTOR_REPEAT_THRESHOLD = 3;

// Post-write validation / self-healing: how many extra agent turns we allow to fix a broken
// compile/lint before giving up and returning whatever was last applied.
const MAX_SELF_HEAL_ATTEMPTS = 2;

/** Shared phrase describing the exploration tools, appended to every agentic system prompt. */
export const AGENT_TOOLS_DESCRIPTION =
    'You have tools available to request additional context that is not already included in the ' +
    'message: use read_manifest to learn the project\'s real dependencies (npm/composer) and ' +
    'search_dependency_usage to see how relevant dependencies are actually used; use find_agents_md ' +
    'to locate existing context documentation in subfolders or sibling packages of a monorepo, and ' +
    'read_file to read it or any other existing relevant file that has not already been shown to you ' +
    '(for example, one omitted for size); use list_directory if you need to see the contents of a ' +
    'folder not included in the tree. If the project uses an installed framework or library (for ' +
    'example, something AGENTS.md only names without detailing its API) and you need to know exactly ' +
    'how it works before using it, do NOT assume its behaviour: use read_dependency_manifest to ' +
    'locate it in node_modules and see its entry points, then list_dependency_files / ' +
    'read_dependency_file to inspect its real code. Call whatever tools you need, as many times as ' +
    'you need, before answering.';

/** Git-like Search/Replace patch format the model must use instead of full-file rewrites, shared
 *  by every prompt that may end up calling AIContextManager.runCodeAgent(). */
export const SEARCH_REPLACE_FORMAT_INSTRUCTIONS =
    'For every file you create or modify, output it using EXACTLY this format, with no other text ' +
    'before, between or after the blocks:\n\n' +
    '>>>FILE: <path relative to the project root>\n' +
    '<<<<<<< SEARCH\n' +
    '<exact existing code snippet to find — leave EMPTY only when creating a brand-new file>\n' +
    '=======\n' +
    '<the new replacement code snippet>\n' +
    '>>>>>>> REPLACE\n' +
    '<<<END\n\n' +
    'A single >>>FILE block may contain more than one SEARCH/REPLACE pair if you need to make ' +
    'several separate edits to the same file. Never output the file\'s full content — only the ' +
    'minimal snippets that need to change. The SEARCH snippet must match real, existing text from ' +
    'the file (read it with read_file first if you have not already seen its exact current content ' +
    'in this conversation); do not guess it. To create a new file, use a single block with an empty ' +
    'SEARCH section and the full new file content as REPLACE. When you have everything you need, ' +
    'respond ONLY with the >>>FILE / <<<END blocks for the files you create or modify — no other ' +
    'commentary.';

interface AgentToolContext {
    /** Starting directory (targetDir in ai:code, projectDir/cwd in ai:describe), BEFORE widening
     *  it with computeExplorationRoot(). Used to locate node_modules the way Node.js itself would
     *  (searching upward from here), rather than from explorationRoot which may sit higher up. */
    projectDir: string;
    explorationRoot: string;
    ignoredDirs: Set<string>;
    /** Absolute paths of files whose FULL (untruncated) content the model has seen this session,
     *  either because they were included whole in the seed message or read in full via read_file.
     *  This is the basis of the "never write blind" guarantee: applyPatches() refuses to overwrite
     *  any existing file that is not in this set. */
    seenFiles: Set<string>;
}

export const AGENT_TOOLS: AITool[] = [
    {
        name: 'list_directory',
        description:
            'Lists the immediate files and subdirectories of a path within the project\'s explorable ' +
            'area. Useful for deciding whether to look deeper into a folder not already in the tree.',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path relative to the explorable area, or "." for the root.' } },
            required: ['path'],
        },
    },
    {
        name: 'read_file',
        description:
            'Reads the full content of a text file within the explorable area. Use it for files ' +
            'omitted from the seed message for size, or outside the original directory but relevant ' +
            '(e.g. a sibling package\'s AGENTS.md in a monorepo, or an existing file you need to see ' +
            'before modifying it).',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path relative to the explorable area.' } },
            required: ['path'],
        },
    },
    {
        name: 'find_agents_md',
        description:
            'Finds every existing AGENTS.md file within the explorable area (including subfolders ' +
            'and, for a monorepo, sibling packages). Returns their relative paths; use read_file to ' +
            'read the one you care about.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'read_manifest',
        description:
            'Finds and summarises every package.json / composer.json in the explorable area: name, ' +
            'version, workspaces/autoload and dependency lists (production and development). Useful ' +
            'to know what libraries the project uses before documenting or using them.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'search_dependency_usage',
        description:
            'Searches the source code for import/require/use lines referencing a specific dependency ' +
            '(by its package name), to understand how and where it is actually used in the project.',
        input_schema: {
            type: 'object',
            properties: { dependency: { type: 'string', description: 'Package name as it appears in package.json or composer.json.' } },
            required: ['dependency'],
        },
    },
    {
        name: 'read_dependency_manifest',
        description:
            'Locates an installed dependency in node_modules (by its exact package name, e.g. ' +
            '"@tyrframework/cli" or "react") and summarises its own package.json: version, description ' +
            'and entry points (main, module, types, exports, bin). The recommended first step before ' +
            'exploring a dependency\'s code.',
        input_schema: {
            type: 'object',
            properties: { packageName: { type: 'string', description: 'Exact package name, with scope if any (e.g. "@tyrframework/cli").' } },
            required: ['packageName'],
        },
    },
    {
        name: 'list_dependency_files',
        description:
            'Lists the files and subdirectories of a folder inside an installed dependency in ' +
            'node_modules. Unlike list_directory (for the project itself), this DOES show folders ' +
            'like dist/build, since in an installed dependency that is usually the real code to inspect.',
        input_schema: {
            type: 'object',
            properties: {
                packageName: { type: 'string', description: 'Exact package name, with scope if any.' },
                path: { type: 'string', description: 'Path relative to the package root, or "." for its root.' },
            },
            required: ['packageName'],
        },
    },
    {
        name: 'read_dependency_file',
        description:
            'Reads the full content of a file inside an installed dependency in node_modules. Use it ' +
            'to understand how a library or framework actually works (types, public API, ' +
            'implementation) instead of assuming its behaviour from the package name or from what ' +
            'AGENTS.md says.',
        input_schema: {
            type: 'object',
            properties: {
                packageName: { type: 'string', description: 'Exact package name, with scope if any.' },
                path: { type: 'string', description: 'Path of the file relative to the package root (use list_dependency_files or read_dependency_manifest to locate it).' },
            },
            required: ['packageName', 'path'],
        },
    },
    {
        name: 'git_diff',
        description:
            "Shows the project's current git status and diff (uncommitted changes vs. HEAD), if it " +
            'is a git repository. Useful to see what has already been modified — by you earlier in ' +
            'this session, or by the user — before making further edits. Read-only: this tool can ' +
            'only inspect the working tree, it can NEVER stage (git add) or commit anything.',
        input_schema: {
            type: 'object',
            properties: {
                staged: { type: 'boolean', description: 'If true, show the staged diff instead of the unstaged working-tree diff.' },
            },
        },
    },
];

export interface AgentRunOptions {
    priority?: TaskPriority;
    maxIterations?: number;
    maxTokens?: number;
}

export interface AgentRunResult {
    content: string;
    promptTokens: number;
    completionTokens: number;
    toolCallsUsed: number;
    priorityUsed: TaskPriority;
}

export interface ValidationResult {
    ran: boolean;
    ok: boolean;
    output?: string;
}

/** Unified diff for a single file changed by applyPatches(), meant to be shown to the human
 *  verbatim (never re-transcribed by the model) — see runCodeAgent()'s callers. */
export interface FileDiff {
    path: string;
    diff: string;
}

export interface CodeAgentResult extends AgentRunResult {
    filesChanged: string[];
    blockedWrites: string[];
    failedEdits: string[];
    fileDiffs: FileDiff[];
    validation: ValidationResult;
    sandbox: SandboxResult;
}

interface FilePatchEdit {
    search: string;
    replace: string;
}

interface FilePatchBlock {
    relPath: string;
    edits: FilePatchEdit[];
}

const FILE_BLOCK_REGEX = />>>FILE:\s*(.+?)\s*\n([\s\S]*?)\n<<<END/g;
// The `\n?` before `=======` (rather than a mandatory `\n`) matters for brand-new files: the
// model is told to leave the SEARCH section EMPTY, and it naturally writes "SEARCH\n======="
// with no blank line in between rather than "SEARCH\n\n=======" — a mandatory `\n` there made
// every new-file creation silently produce zero matches (no blocks, "no changes generated").
const SEARCH_REPLACE_REGEX = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g;

/**
 * @class AIContextManager
 * @description Owns everything an AI coding assistant needs to safely operate on a project:
 * finding/generating guideline files (CLAUDE.md/AGENTS.md), and — the bulk of this class — running
 * a tool-using agent loop that starts from a minimal seed (project tree + guidelines) and lets the
 * model pull in whatever else it needs (a file, a directory listing, a dependency's real source)
 * via AGENT_TOOLS. It also owns the Search/Replace patch engine used to apply the model's edits
 * (instead of full-file rewrites), a Loop Detector that aborts runaway tool-call loops, and a
 * post-write validation step that feeds compiler/linter errors back to the model and escalates the
 * routing priority (see AIVendorManager.bumpPriority) when a fix attempt breaks the build.
 *
 * Commands built on top of this manager (ai:code, ai:describe) should stay thin: resolve paths,
 * build the seed messages via PromptTemplateManager + buildExplorationTree()/getContext(), call
 * runCodeAgent()/runDescribeAgent(), and log the result.
 */
export class AIContextManager {
    private fs: FileSystemManager;
    private shell: ShellManager;
    private ai: AIVendorManager;
    private logger: Logger;
    private git: GitManager;
    private sandbox: SandboxManager;

    constructor(fs: FileSystemManager, shell: ShellManager, ai: AIVendorManager, logger: Logger, git: GitManager, sandbox: SandboxManager) {
        this.fs = fs;
        this.shell = shell;
        this.ai = ai;
        this.logger = logger;
        this.git = git;
        this.sandbox = sandbox;
    }

    // === Guideline files (CLAUDE.md / AGENTS.md) =================================================

    /**
     * @method findContextFiles
     * @description Busca los archivos de directrices conocidos (README.md, CLAUDE.md, AGENTS.md,
     * CONTEXT.md, .cursorrules, copilot-instructions.md) no solo dentro de `dir`, sino tanto hacia
     * fuera (directorios ancestros, hasta CONTEXT_SEARCH_UPWARD_LEVELS niveles — un AGENTS.md en la
     * raíz de un monorepo sigue aplicando a un paquete dentro de él) como hacia dentro (subcarpetas,
     * hasta CONTEXT_SEARCH_DOWNWARD_LEVELS niveles — un paquete anidado puede documentarse a sí
     * mismo). La "relevancia" se determina de forma determinista, sin llamar a la IA (esto se
     * ejecuta antes de cada comando, así que tiene que ser barato):
     *   - Hacia fuera: se detiene en cuanto se cruza la raíz del repo (una carpeta .git), además del
     *     tope de niveles — más allá de eso nunca es relevante.
     *   - Hacia dentro: NO se desciende más allá del primer directorio que tenga su propio
     *     package.json/composer.json (un límite de paquete independiente) salvo para recoger el
     *     archivo de contexto que esté justo en ese límite; lo que hay más adentro pertenece a ese
     *     otro paquete, no a `dir`.
     *   - Si aun así se encuentran más de MAX_CONTEXT_FILES candidatos, ganan los más cercanos a `dir`.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto (o subcarpeta) desde la que buscar.
     * @returns {Promise<string[]>} Rutas absolutas de los archivos de directrices relevantes, del más al menos cercano.
     */
    public async findContextFiles(dir: string): Promise<string[]> {
        const found = new Map<string, number>();

        const record = (fullPath: string, distance: number) => {
            if (!this.fs.exists(fullPath)) return;
            const previous = found.get(fullPath);
            if (previous === undefined || distance < previous) found.set(fullPath, distance);
        };

        // Here (distance 0).
        for (const name of CONTEXT_FILENAMES) record(path.join(dir, name), 0);

        // Outward: ancestor directories, stopping at the repo root once reached.
        let upDir = dir;
        for (let level = 1; level <= CONTEXT_SEARCH_UPWARD_LEVELS; level++) {
            const parent = path.dirname(upDir);
            if (parent === upDir) break; // filesystem root
            upDir = parent;
            for (const name of CONTEXT_FILENAMES) record(path.join(upDir, name), level);
            if (this.fs.exists(path.join(upDir, '.git'))) break;
        }

        // Inward: subdirectories, pruned at package boundaries.
        await this.walkDownForContextFiles(dir, 1, false, record);

        return [...found.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, MAX_CONTEXT_FILES)
            .map(([fullPath]) => fullPath);
    }

    /** Recursive helper for the inward half of findContextFiles(). `crossedPackageBoundary` starts
     *  false and flips to true once we step into a directory with its own manifest — from that
     *  point on we keep recursing (so deeper package boundaries are still detected and stopped at
     *  in turn) but stop *recording* candidates, since anything past that boundary belongs to a
     *  separately versioned sub-package rather than `dir`. */
    private async walkDownForContextFiles(
        currentDir: string,
        level: number,
        crossedPackageBoundary: boolean,
        record: (fullPath: string, distance: number) => void
    ): Promise<void> {
        if (level > CONTEXT_SEARCH_DOWNWARD_LEVELS) return;

        let entries;
        try {
            entries = await this.fs.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
            const childDir = path.join(currentDir, entry.name);

            if (!crossedPackageBoundary) {
                for (const name of CONTEXT_FILENAMES) record(path.join(childDir, name), level);
            }

            const childHasOwnManifest = [...MANIFEST_FILENAMES].some(name => this.fs.exists(path.join(childDir, name)));
            await this.walkDownForContextFiles(childDir, level + 1, crossedPackageBoundary || childHasOwnManifest, record);
        }
    }

    private async readAndValidate(filePath: string): Promise<string | null> {
        const content = await this.fs.read(filePath);
        if (!content || !content.trim()) return null;
        return content.trim();
    }

    /**
     * @method buildPackageJsonSummary
     * @description Parsea package.json de forma segura (try/catch) y vuelve a serializar
     * únicamente los campos relevantes para el contexto arquitectónico. A diferencia de un
     * `.slice()` a ciegas, nunca entrega al vendor de IA un JSON truncado y sintácticamente roto.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto.
     * @returns {Promise<string | null>} Sección Markdown lista para el snapshot, o null si no
     * hay package.json legible o válido.
     */
    private async buildPackageJsonSummary(dir: string): Promise<string | null> {
        const pkgPath = path.join(dir, 'package.json');
        if (!this.fs.exists(pkgPath)) return null;

        const raw = await this.fs.read(pkgPath);
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const summary: Record<string, unknown> = {};
            for (const field of PACKAGE_JSON_FIELDS) {
                if (parsed[field] !== undefined) summary[field] = parsed[field];
            }
            return `# package.json (summary)\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``;
        } catch {
            this.logger.info(`package.json en ${pkgPath} no es JSON válido, se omite del snapshot.`);
            return null;
        }
    }

    /**
     * @method scanDirectoryTree
     * @description Escaneo recursivo de directorios agnóstico al SO usando la API nativa de
     * Node.js (sin subprocesos de shell), acotado en profundidad — pensado para el snapshot que
     * alimenta la generación de directrices. Para el árbol usado como semilla del agente (sin tope
     * de profundidad), ver buildExplorationTree().
     * @param {string} rootDir - Ruta absoluta desde la que empezar a escanear.
     * @param {number} maxDepth - Profundidad máxima de recursión.
     * @param {number} maxEntriesPerDir - Máximo de entradas listadas por carpeta antes de truncar.
     * @param {Set<string>} ignoredDirs - Nombres de directorios a omitir por completo.
     * @returns {Promise<string>} Representación en texto indentado del árbol.
     */
    private async scanDirectoryTree(
        rootDir: string,
        maxDepth: number = SNAPSHOT_TREE_MAX_DEPTH,
        maxEntriesPerDir: number = SNAPSHOT_TREE_MAX_ENTRIES_PER_DIR,
        ignoredDirs: Set<string> = DEFAULT_IGNORED_DIRS
    ): Promise<string> {
        const lines: string[] = [path.basename(rootDir) || rootDir];

        const walk = async (currentDir: string, depth: number, prefix: string): Promise<void> => {
            if (depth > maxDepth) return;

            let entries;
            try {
                entries = await this.fs.readdir(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            entries = entries
                .filter(entry => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            const visible = entries.slice(0, maxEntriesPerDir);
            const hiddenCount = entries.length - visible.length;

            for (const entry of visible) {
                lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
                if (entry.isDirectory()) {
                    await walk(path.join(currentDir, entry.name), depth + 1, `${prefix}  `);
                }
            }

            if (hiddenCount > 0) {
                lines.push(`${prefix}… y ${hiddenCount} elemento(s) más`);
            }
        };

        await walk(rootDir, 1, '  ');
        return lines.join('\n');
    }

    /**
     * @method buildProjectSnapshot
     * @description Ensambla el material que necesita el vendor de IA para escribir directrices:
     * un resumen seguro de package.json, el README y un árbol de directorios nativo. Sin
     * subprocesos de shell.
     */
    private async buildProjectSnapshot(dir: string): Promise<string> {
        const parts: string[] = [];

        const pkgSummary = await this.buildPackageJsonSummary(dir);
        if (pkgSummary) parts.push(pkgSummary);

        const readmePath = path.join(dir, 'README.md');
        if (this.fs.exists(readmePath)) {
            const readme = await this.fs.read(readmePath);
            if (readme) parts.push(`# README.md\n${readme.slice(0, SNAPSHOT_SECTION_MAX_CHARS)}`);
        }

        const tree = await this.scanDirectoryTree(dir).catch(() => '');
        if (tree) parts.push(`# Project structure\n${tree.slice(0, SNAPSHOT_SECTION_MAX_CHARS)}`);

        return parts.join('\n\n');
    }

    /**
     * @method generateContextFile
     * @description Escanea el proyecto y le pide al vendor de IA configurado que sintetice un
     * archivo de directrices, luego lo escribe como CLAUDE.md en la raíz del proyecto.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto.
     * @returns {Promise<string>} Ruta absoluta del archivo generado.
     */
    public async generateContextFile(dir: string): Promise<string> {
        this.logger.info('No se encontró archivo de contexto. Analizando el proyecto para generar uno...');

        const snapshot = await this.buildProjectSnapshot(dir);
        const messages: AIMessage[] = [
            { role: 'system', content: GUIDELINES_SYSTEM_PROMPT },
            { role: 'user', content: snapshot || 'The project has no readable package.json, README or file tree.' },
        ];

        let result;
        try {
            result = await this.ai.complete(messages, { temperature: 0.2 });
        } catch (err) {
            throw new TyrError(
                `No se pudo generar el archivo de contexto para ${dir}`,
                err,
                'Revisa la configuración de tu vendor de IA y la conectividad de red, luego reintenta.'
            );
        }

        const targetPath = path.join(dir, GENERATED_FILENAME);
        await this.fs.write(targetPath, result.content.trim() + '\n');

        this.logger.success(`Archivo de contexto generado en: ${targetPath}`);
        return targetPath;
    }

    /**
     * @method readGuidelines
     * @description Encuentra los archivos de directrices existentes (generando uno vía IA si no
     * hay ninguno), los lee y valida, y los devuelve como bloques discretos etiquetados.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto.
     * @returns {Promise<GuidelinesBlock[]>}
     */
    public async readGuidelines(dir: string): Promise<GuidelinesBlock[]> {
        let files = await this.findContextFiles(dir);

        if (files.length === 0) {
            const generated = await this.generateContextFile(dir);
            files = [generated];
        }

        const blocks: GuidelinesBlock[] = [];
        for (const file of files) {
            const content = await this.readAndValidate(file);
            // Relative to `dir` rather than just the basename: with the search now reaching
            // outward/inward, two blocks can share a filename (e.g. an AGENTS.md here AND one two
            // levels up) — the path disambiguates which is which for whoever reads getGuidelinesText().
            if (content) blocks.push({ fileName: path.relative(dir, file) || path.basename(file), content });
        }

        if (blocks.length === 0) {
            throw new TyrError(
                `Se encontraron archivos de contexto pero están vacíos o son ilegibles en: ${dir}`,
                null,
                'Revisa el contenido de tu archivo CLAUDE.md/AGENTS.md.'
            );
        }

        return blocks;
    }

    /**
     * @method getGuidelinesText
     * @description Envoltorio de conveniencia sobre readGuidelines() que devuelve el texto plano
     * combinado de las directrices, sin envolver en roles/mensajes.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto.
     * @returns {Promise<string>}
     */
    public async getGuidelinesText(dir: string): Promise<string> {
        const blocks = await this.readGuidelines(dir);
        return blocks.map(b => `<!-- ${b.fileName} -->\n${b.content}`).join('\n\n');
    }

    /**
     * @method getContext
     * @description Punto de entrada para uso puntual: encuentra/genera archivos de directrices y
     * los empaqueta como un único mensaje 'system' listo para prepender a un prompt. Es también la
     * pieza clave de la guía de exploración dinámica del agente: junto con buildExplorationTree(),
     * es lo ÚNICO con lo que se siembra el contexto inicial de runCodeAgent()/runDescribeAgent() —
     * el resto lo pide el propio modelo con AGENT_TOOLS.
     * @param {string} dir - Ruta absoluta a la raíz del proyecto.
     * @returns {Promise<AIMessage[]>}
     * @example
     * const contextMessages = await context.getContext(process.cwd());
     * const result = await ai.complete([...contextMessages, { role: 'user', content: 'Fix this bug...' }]);
     */
    public async getContext(dir: string): Promise<AIMessage[]> {
        const text = await this.getGuidelinesText(dir);
        return [{ role: 'system', content: text }];
    }

    // === Exploration tree (agent seed) ============================================================

    private isDirectorySync(target: string): boolean {
        try {
            return statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * @method buildExplorationTree
     * @description Full-depth directory tree (only capped by entries-per-folder, not depth),
     * used to seed the agent loop. Unlike scanDirectoryTree() (capped depth, used for guideline
     * generation), the agent can always ask for more with list_directory, so this favours breadth
     * over an artificial depth limit.
     * @param {string} rootDir - Absolute path to start scanning from.
     * @param {Set<string>} ignoredDirs - Directory names to skip entirely.
     * @param {number} maxEntriesPerDir - Max entries listed per folder before truncating.
     * @returns {Promise<string>} Indented text tree.
     * @example
     * const tree = await aiContext.buildExplorationTree(targetDir);
     */
    public async buildExplorationTree(
        rootDir: string,
        ignoredDirs: Set<string> = DEFAULT_IGNORED_DIRS,
        maxEntriesPerDir: number = TREE_MAX_ENTRIES_PER_DIR
    ): Promise<string> {
        const lines: string[] = [`${path.basename(rootDir) || rootDir}/`];

        const walk = async (dir: string, prefix: string): Promise<void> => {
            let entries = await this.fs.readdir(dir, { withFileTypes: true });

            entries = entries
                .filter(entry => !(entry.isDirectory() && ignoredDirs.has(entry.name)))
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            const visible = entries.slice(0, maxEntriesPerDir);
            const hiddenCount = entries.length - visible.length;

            for (const entry of visible) {
                lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
                if (entry.isDirectory()) {
                    await walk(path.join(dir, entry.name), `${prefix}  `);
                }
            }

            if (hiddenCount > 0) {
                lines.push(`${prefix}… and ${hiddenCount} more item(s)`);
            }
        };

        await walk(rootDir, '  ');
        return lines.join('\n');
    }

    /**
     * @method findReadme
     * @description Finds the project's README (any common extension) and returns its name and
     * content, or null if there isn't one / it's empty.
     * @param {string} dir - Absolute path to the project root.
     * @returns {Promise<{name: string; content: string} | null>}
     * @example
     * const readme = await aiContext.findReadme(projectDir);
     */
    public async findReadme(dir: string): Promise<{ name: string; content: string } | null> {
        const entries = await this.fs.readdir(dir, { withFileTypes: true });
        const match = entries.find(entry => entry.isFile() && README_PATTERN.test(entry.name));
        if (!match) return null;

        const content = await this.fs.read(path.join(dir, match.name));
        if (!content || !content.trim()) return null;

        return { name: match.name, content };
    }

    // === Exploration tools (tool use) =============================================================

    private computeExplorationRoot(startDir: string, maxUpwardLevels: number = MAX_UPWARD_SEARCH_LEVELS): string {
        let dir = startDir;
        for (let i = 0; i < maxUpwardLevels; i++) {
            if (this.fs.exists(path.join(dir, '.git'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return startDir;
    }

    private resolveSafePath(explorationRoot: string, requested: string): string {
        const target = requested && requested.trim() ? requested.trim() : '.';
        const resolved = path.resolve(explorationRoot, target);
        const rel = path.relative(explorationRoot, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new TyrError(`Path outside the allowed area: ${requested}`);
        }
        return resolved;
    }

    /** Mirrors Node.js module resolution: walks up from startDir looking for node_modules/<pkg>,
     *  not limited to the explorable area, since hoisted monorepos can place it above the repo
     *  root. Read-only and strictly scoped to "node_modules/<that exact package>", so this is not
     *  a sandbox escape even though it can walk above the repo. */
    private resolveDependencyDir(startDir: string, packageName: string): string | null {
        let dir = startDir;
        for (let i = 0; i <= NODE_MODULES_SEARCH_MAX_LEVELS; i++) {
            const candidate = path.join(dir, 'node_modules', packageName);
            if (this.fs.exists(candidate) && this.isDirectorySync(candidate)) return candidate;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    private truncateForTool(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS): string {
        if (text.length <= maxChars) return text;
        const omitted = text.length - maxChars;
        return `${text.slice(0, maxChars)}\n… (truncated, ${omitted} characters omitted)`;
    }

    private async collectFiles(rootDir: string, ignoredDirs: Set<string>): Promise<string[]> {
        const results: string[] = [];

        const walk = async (dir: string): Promise<void> => {
            const entries = await this.fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (ignoredDirs.has(entry.name)) continue;
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    results.push(fullPath);
                }
            }
        };

        await walk(rootDir);
        return results;
    }

    private async findFilesByName(root: string, ignoredDirs: Set<string>, names: Set<string>): Promise<string[]> {
        const results: string[] = [];

        const walk = async (dir: string): Promise<void> => {
            const entries = await this.fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (ignoredDirs.has(entry.name)) continue;
                    await walk(fullPath);
                } else if (entry.isFile() && names.has(entry.name)) {
                    results.push(fullPath);
                }
            }
        };

        await walk(root);
        return results;
    }

    private summarizeManifest(filename: string, data: any): string {
        if (filename === 'package.json') {
            const deps = Object.keys(data.dependencies || {});
            const devDeps = Object.keys(data.devDependencies || {});
            const lines = [`Name: ${data.name ?? '(unnamed)'}`, `Version: ${data.version ?? '?'}`];
            if (data.workspaces) lines.push(`Workspaces: ${JSON.stringify(data.workspaces)}`);
            if (deps.length) lines.push(`Dependencies: ${deps.join(', ')}`);
            if (devDeps.length) lines.push(`Dev dependencies: ${devDeps.join(', ')}`);
            return lines.join('\n');
        }

        if (filename === 'composer.json') {
            const req = Object.keys(data.require || {});
            const reqDev = Object.keys(data['require-dev'] || {});
            const lines = [`Name: ${data.name ?? '(unnamed)'}`];
            if (req.length) lines.push(`require: ${req.join(', ')}`);
            if (reqDev.length) lines.push(`require-dev: ${reqDev.join(', ')}`);
            if (data.autoload) lines.push(`Autoload: ${JSON.stringify(data.autoload)}`);
            return lines.join('\n');
        }

        return JSON.stringify(data);
    }

    private summarizeDependencyManifest(data: any): string {
        const lines = [`Name: ${data.name ?? '(unnamed)'}`, `Version: ${data.version ?? '?'}`];
        if (data.description) lines.push(`Description: ${data.description}`);
        if (data.main) lines.push(`main: ${data.main}`);
        if (data.module) lines.push(`module: ${data.module}`);
        if (data.types || data.typings) lines.push(`types: ${data.types ?? data.typings}`);
        if (data.exports) lines.push(`exports: ${JSON.stringify(data.exports, null, 2)}`);
        if (data.bin) lines.push(`bin: ${JSON.stringify(data.bin)}`);
        return lines.join('\n');
    }

    private async toolListDirectory(ctx: AgentToolContext, input: any): Promise<string> {
        const target = this.resolveSafePath(ctx.explorationRoot, input?.path);
        if (!this.isDirectorySync(target)) return `Error: "${input?.path}" is not a directory within the explorable area.`;

        const entries = await this.fs.readdir(target, { withFileTypes: true });
        const visible = entries.filter(e => !(e.isDirectory() && ctx.ignoredDirs.has(e.name)));
        if (visible.length === 0) return '(empty directory)';

        return visible.map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
    }

    private async toolReadFile(ctx: AgentToolContext, input: any): Promise<string> {
        if (!input?.path) return 'Error: missing "path" parameter.';
        const target = this.resolveSafePath(ctx.explorationRoot, input.path);

        if (!this.fs.exists(target)) return `Error: file does not exist: ${input.path}`;
        if (this.isDirectorySync(target)) return `Error: "${input.path}" is a directory, use list_directory.`;

        const content = await this.fs.read(target);
        if (!content || !content.trim()) {
            ctx.seenFiles.add(target);
            return '(empty file)';
        }

        if (content.length > MAX_TOOL_RESULT_CHARS) {
            // Truncated: the model has NOT seen the full file, so it is not marked as "seen" —
            // applyPatches() will refuse to blindly overwrite it later.
            return this.truncateForTool(content);
        }

        ctx.seenFiles.add(target);
        return content;
    }

    private async toolFindAgentsMd(ctx: AgentToolContext): Promise<string> {
        const found = await this.findFilesByName(ctx.explorationRoot, ctx.ignoredDirs, new Set([AGENTS_MD_FILENAME]));
        if (found.length === 0) return 'No existing AGENTS.md files found in the explorable area.';
        return found.map(p => path.relative(ctx.explorationRoot, p)).join('\n');
    }

    private async toolReadManifest(ctx: AgentToolContext): Promise<string> {
        const manifests = await this.findFilesByName(ctx.explorationRoot, ctx.ignoredDirs, MANIFEST_FILENAMES);
        if (manifests.length === 0) return 'No package.json or composer.json found in the explorable area.';

        const parts: string[] = [];
        for (const manifestPath of manifests) {
            const rel = path.relative(ctx.explorationRoot, manifestPath);
            const raw = await this.fs.read(manifestPath);
            try {
                const data = JSON.parse(raw ?? '{}');
                parts.push(`# ${rel}\n${this.summarizeManifest(path.basename(manifestPath), data)}`);
            } catch {
                parts.push(`# ${rel}\n(could not be parsed as valid JSON)`);
            }
        }

        return this.truncateForTool(parts.join('\n\n'));
    }

    private async toolSearchDependencyUsage(ctx: AgentToolContext, input: any): Promise<string> {
        const dependency: string | undefined = input?.dependency;
        if (!dependency) return 'Error: missing "dependency" parameter.';

        const files = await this.collectFiles(ctx.explorationRoot, ctx.ignoredDirs);
        const matches: string[] = [];

        for (const filePath of files) {
            if (matches.length >= MAX_DEPENDENCY_MATCHES) break;
            if (!READABLE_EXTENSIONS.has(path.extname(filePath))) continue;

            const content = await this.fs.read(filePath);
            if (!content) continue;

            const rel = path.relative(ctx.explorationRoot, filePath);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length && matches.length < MAX_DEPENDENCY_MATCHES; i++) {
                const line = lines[i];
                if (line.includes(dependency) && /\b(import|require|use|from)\b/.test(line)) {
                    matches.push(`${rel}:${i + 1}: ${line.trim()}`);
                }
            }
        }

        if (matches.length === 0) return `No import/require/use references to "${dependency}" found in the code.`;
        return this.truncateForTool(matches.join('\n'));
    }

    private async toolReadDependencyManifest(ctx: AgentToolContext, input: any): Promise<string> {
        const packageName = input?.packageName;
        if (!packageName) return 'Error: missing "packageName" parameter.';

        const depDir = this.resolveDependencyDir(ctx.projectDir, packageName);
        if (!depDir) return `Error: "${packageName}" was not found in any node_modules reachable from the project.`;

        const manifestPath = path.join(depDir, 'package.json');
        if (!this.fs.exists(manifestPath)) return `Error: "${packageName}" has no package.json in ${depDir}.`;

        const raw = await this.fs.read(manifestPath);
        try {
            return this.summarizeDependencyManifest(JSON.parse(raw ?? '{}'));
        } catch {
            return `Error: "${packageName}"'s package.json is not valid JSON.`;
        }
    }

    private async toolListDependencyFiles(ctx: AgentToolContext, input: any): Promise<string> {
        const packageName = input?.packageName;
        if (!packageName) return 'Error: missing "packageName" parameter.';

        const depDir = this.resolveDependencyDir(ctx.projectDir, packageName);
        if (!depDir) return `Error: "${packageName}" was not found in any node_modules reachable from the project.`;

        let target: string;
        try {
            target = this.resolveSafePath(depDir, input?.path);
        } catch (err: any) {
            return `Error: ${err.message}`;
        }

        if (!this.isDirectorySync(target)) return `Error: "${input?.path ?? '.'}" is not a directory within "${packageName}".`;

        const entries = await this.fs.readdir(target, { withFileTypes: true });
        const visible = entries.filter(e => !(e.isDirectory() && PACKAGE_IGNORED_DIRS.has(e.name)));
        if (visible.length === 0) return '(empty directory)';

        return visible.map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
    }

    private async toolReadDependencyFile(ctx: AgentToolContext, input: any): Promise<string> {
        const packageName = input?.packageName;
        if (!packageName) return 'Error: missing "packageName" parameter.';
        if (!input?.path) return 'Error: missing "path" parameter.';

        const depDir = this.resolveDependencyDir(ctx.projectDir, packageName);
        if (!depDir) return `Error: "${packageName}" was not found in any node_modules reachable from the project.`;

        let target: string;
        try {
            target = this.resolveSafePath(depDir, input.path);
        } catch (err: any) {
            return `Error: ${err.message}`;
        }

        if (!this.fs.exists(target)) return `Error: file does not exist in "${packageName}": ${input.path}`;
        if (this.isDirectorySync(target)) return `Error: "${input.path}" is a directory within "${packageName}", use list_dependency_files.`;

        const content = await this.fs.read(target);
        if (!content || !content.trim()) return '(empty file)';
        return this.truncateForTool(content);
    }

    /** Read-only: status()/diff() never stage or commit anything (see GitManager). */
    private async toolGitDiff(ctx: AgentToolContext, input: any): Promise<string> {
        const status = await this.git.status(ctx.projectDir);
        const diffText = await this.git.diff(ctx.projectDir, { staged: !!input?.staged });
        return this.truncateForTool(`Status:\n${status}\n\nDiff:\n${diffText}`);
    }

    private async executeAgentTool(ctx: AgentToolContext, name: string, input: any): Promise<string> {
        try {
            switch (name) {
                case 'list_directory': return await this.toolListDirectory(ctx, input);
                case 'read_file': return await this.toolReadFile(ctx, input);
                case 'find_agents_md': return await this.toolFindAgentsMd(ctx);
                case 'read_manifest': return await this.toolReadManifest(ctx);
                case 'search_dependency_usage': return await this.toolSearchDependencyUsage(ctx, input);
                case 'read_dependency_manifest': return await this.toolReadDependencyManifest(ctx, input);
                case 'list_dependency_files': return await this.toolListDependencyFiles(ctx, input);
                case 'read_dependency_file': return await this.toolReadDependencyFile(ctx, input);
                case 'git_diff': return await this.toolGitDiff(ctx, input);
                default: return `Error: unknown tool "${name}".`;
            }
        } catch (err: any) {
            return `Error running tool "${name}": ${err?.message ?? String(err)}`;
        }
    }

    // === Agent loop (tool use + Loop Detector + priority routing) ================================

    /**
     * Runs the conversation with the model, letting it call AGENT_TOOLS for extra context before
     * delivering a final answer. Mutates `messages` in place (pushes assistant/tool turns onto it)
     * so a caller doing self-healing retries can keep extending the same conversation. Stops when
     * the model answers without requesting a tool, when maxIterations is reached (a final answer is
     * then forced), or when the Loop Detector aborts a runaway sequence of identical tool calls.
     */
    private async runAgentLoop(
        messages: AIMessage[],
        ctx: AgentToolContext,
        tokens: TokenManager,
        options: AgentRunOptions = {}
    ): Promise<AgentRunResult> {
        const priority = options.priority ?? 'mid';
        const maxIterations = options.maxIterations ?? DEFAULT_MAX_AGENT_ITERATIONS;
        const completeOptions = { tools: AGENT_TOOLS, ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}) };

        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let toolCallsUsed = 0;
        let lastCallSignature: string | null = null;
        let consecutiveCount = 0;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            tokens.assertWithinLimit(messages);
            const result = await this.ai.completeWithPriority(messages, priority, completeOptions);

            totalPromptTokens += result.promptTokens ?? 0;
            totalCompletionTokens += result.completionTokens ?? 0;
            tokens.recordUsage(result.vendor, result.model, result.promptTokens ?? 0, result.completionTokens ?? 0);

            const toolUses = (result.blocks ?? []).filter(
                (b): b is Extract<AIContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
            );

            if (toolUses.length === 0) {
                return { content: result.content, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, toolCallsUsed, priorityUsed: priority };
            }

            messages.push({ role: 'assistant', content: result.blocks });

            const toolResults: AIContentBlock[] = [];
            let aborted = false;

            for (const call of toolUses) {
                toolCallsUsed++;
                const signature = `${call.name}(${JSON.stringify(call.input ?? {})})`;
                consecutiveCount = signature === lastCallSignature ? consecutiveCount + 1 : 1;
                lastCallSignature = signature;

                if (consecutiveCount >= LOOP_DETECTOR_REPEAT_THRESHOLD) {
                    this.logger.warn(`Loop detector: '${call.name}' called with identical arguments ${consecutiveCount} times in a row — aborting the agent loop.`);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: call.id,
                        content: 'Error: aborted by the loop detector (identical tool call repeated too many times).',
                        is_error: true,
                    });
                    aborted = true;
                    break;
                }

                this.logger.info(`Agent tool call → ${signature}`);
                const output = await this.executeAgentTool(ctx, call.name, call.input);
                toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: output });
            }

            messages.push({ role: 'user', content: toolResults });

            if (aborted) {
                return {
                    content: '(stopped early: the loop detector aborted the session after a repeated tool call)',
                    promptTokens: totalPromptTokens,
                    completionTokens: totalCompletionTokens,
                    toolCallsUsed,
                    priorityUsed: priority,
                };
            }
        }

        this.logger.info(`Agent iteration limit reached (${maxIterations}); forcing a final answer.`);
        messages.push({ role: 'user', content: 'No more tool calls are available. Deliver your final answer now with whatever information you have.' });

        tokens.assertWithinLimit(messages);
        const final = await this.ai.completeWithPriority(messages, priority, options.maxTokens ? { maxTokens: options.maxTokens } : {});
        totalPromptTokens += final.promptTokens ?? 0;
        totalCompletionTokens += final.completionTokens ?? 0;
        tokens.recordUsage(final.vendor, final.model, final.promptTokens ?? 0, final.completionTokens ?? 0);

        return { content: final.content, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, toolCallsUsed, priorityUsed: priority };
    }

    // === Search/Replace patch engine ===============================================================

    private parsePatchBlocks(responseText: string): FilePatchBlock[] {
        const blocks: FilePatchBlock[] = [];

        FILE_BLOCK_REGEX.lastIndex = 0;
        let fileMatch: RegExpExecArray | null;
        while ((fileMatch = FILE_BLOCK_REGEX.exec(responseText)) !== null) {
            const relPath = fileMatch[1].trim();
            const body = fileMatch[2];
            const edits: FilePatchEdit[] = [];

            SEARCH_REPLACE_REGEX.lastIndex = 0;
            let editMatch: RegExpExecArray | null;
            while ((editMatch = SEARCH_REPLACE_REGEX.exec(body)) !== null) {
                edits.push({ search: editMatch[1], replace: editMatch[2] });
            }

            if (edits.length > 0) blocks.push({ relPath, edits });
        }

        return blocks;
    }

    /**
     * Applies one SEARCH/REPLACE edit to `original`. Tries an exact substring match first; if that
     * fails, falls back to a line-by-line match that ignores leading/trailing whitespace per line,
     * so the model doesn't have to reproduce indentation byte-for-byte. Returns applied: false if
     * neither matches, so the caller can reject the edit instead of corrupting the file.
     */
    private applySearchReplace(original: string, search: string, replace: string): { content: string; applied: boolean } {
        if (search.trim() === '') {
            // Only meaningful for brand-new files; callers must guard this case before writing to
            // an existing file with an empty SEARCH block.
            return { content: replace, applied: true };
        }

        const exactIndex = original.indexOf(search);
        if (exactIndex !== -1) {
            return { content: original.slice(0, exactIndex) + replace + original.slice(exactIndex + search.length), applied: true };
        }

        const originalLines = original.split('\n');
        const searchLines = search.split('\n');
        const normalize = (line: string) => line.trim();

        for (let start = 0; start <= originalLines.length - searchLines.length; start++) {
            let matches = true;
            for (let i = 0; i < searchLines.length; i++) {
                if (normalize(originalLines[start + i]) !== normalize(searchLines[i])) { matches = false; break; }
            }
            if (!matches) continue;

            const before = originalLines.slice(0, start);
            const after = originalLines.slice(start + searchLines.length);
            return { content: [...before, replace, ...after].join('\n'), applied: true };
        }

        return { content: original, applied: false };
    }

    /**
     * Applies every parsed patch block within `targetDir`. Enforces two safety rules regardless of
     * what the model asked for: writes may never resolve outside targetDir, and an existing file is
     * never overwritten unless its full content was actually seen this session (seenFiles) — a
     * brand-new file (empty SEARCH, no existing file at that path) is exempt from the second rule.
     */
    private async applyPatches(
        targetDir: string,
        blocks: FilePatchBlock[],
        seenFiles: Set<string>
    ): Promise<{ filesChanged: string[]; blockedWrites: string[]; failedEdits: string[]; fileDiffs: FileDiff[] }> {
        const filesChanged: string[] = [];
        const blockedWrites: string[] = [];
        const failedEdits: string[] = [];
        const fileDiffs: FileDiff[] = [];

        for (const block of blocks) {
            const resolvedPath = path.resolve(targetDir, block.relPath);
            const withinTarget = resolvedPath === targetDir || resolvedPath.startsWith(targetDir + path.sep);

            if (!withinTarget) {
                this.logger.warn(`Patch ignored, outside the working directory: ${block.relPath}`);
                continue;
            }

            const existed = this.fs.exists(resolvedPath);
            const isNewFileEdit = block.edits.length === 1 && block.edits[0].search.trim() === '';

            if (existed && !seenFiles.has(resolvedPath)) {
                this.logger.warn(`Patch REJECTED (no blind overwrite): "${block.relPath}" already exists and its full content was not read this session.`);
                blockedWrites.push(block.relPath);
                continue;
            }

            if (!existed && !isNewFileEdit) {
                this.logger.warn(`Patch ignored: "${block.relPath}" does not exist and the block is not a valid new-file creation (empty SEARCH).`);
                failedEdits.push(block.relPath);
                continue;
            }

            const beforeContent = existed ? ((await this.fs.read(resolvedPath)) ?? '') : '';
            let content = beforeContent;
            let ok = true;

            for (const edit of block.edits) {
                const result = this.applySearchReplace(content, edit.search, edit.replace);
                if (!result.applied) { ok = false; break; }
                content = result.content;
            }

            if (!ok) {
                this.logger.warn(`Patch failed to apply (SEARCH text not found, even fuzzily): ${block.relPath}`);
                failedEdits.push(block.relPath);
                continue;
            }

            const finalContent = content.endsWith('\n') ? content : content + '\n';
            await this.fs.write(resolvedPath, finalContent);
            seenFiles.add(resolvedPath);
            this.logger.success(`${existed ? 'Modified' : 'Created'}: ${resolvedPath}`);
            filesChanged.push(block.relPath);
            fileDiffs.push({ path: block.relPath, diff: createPatch(block.relPath, beforeContent, finalContent, '', '', { context: 3 }) });
        }

        return { filesChanged, blockedWrites, failedEdits, fileDiffs };
    }

    // === Post-write validation (self-healing) ======================================================

    /**
     * Best-effort, non-destructive validation: prefers `tsc --noEmit` when a tsconfig.json is
     * present, otherwise runs the project's `typecheck` or `lint` npm script if one exists. Returns
     * { ran: false } when no validator could be detected, which callers should treat as "assume ok"
     * rather than as a failure.
     */
    private async runValidation(dir: string): Promise<ValidationResult> {
        const originalCwd = this.shell.getCwd();

        try {
            if (this.fs.exists(path.join(dir, 'tsconfig.json'))) {
                this.shell.cd(dir);
                await this.shell.exec('npx tsc --noEmit');
                return { ran: true, ok: true };
            }

            const pkgPath = path.join(dir, 'package.json');
            if (this.fs.exists(pkgPath)) {
                const raw = await this.fs.read(pkgPath);
                let scripts: Record<string, string> = {};
                try {
                    scripts = raw ? (JSON.parse(raw).scripts ?? {}) : {};
                } catch {
                    scripts = {};
                }

                const script = scripts.typecheck ? 'typecheck' : scripts.lint ? 'lint' : null;
                if (script) {
                    this.shell.cd(dir);
                    await this.shell.exec(`npm run ${script}`);
                    return { ran: true, ok: true };
                }
            }

            return { ran: false, ok: true };
        } catch (err: any) {
            const raw = err?.originalError?.stderr || err?.originalError?.stdout || err?.originalError?.message || err?.message;
            return { ran: true, ok: false, output: this.truncateForTool(String(raw ?? 'Unknown validation error')) };
        } finally {
            this.shell.cd(originalCwd);
        }
    }

    // === High-level entry points ===================================================================

    /**
     * @method runCodeAgent
     * @description Runs the full ai:code pipeline: the tool-use agent loop (seeded only with
     * `messages`, typically tree + AGENTS.md + the task, built by the caller via
     * PromptTemplateManager + buildExplorationTree()/getContext()), parses the model's
     * Search/Replace blocks, applies them under the blind-overwrite guard, and — if any file
     * changed — runs post-write validation. On a validation failure, the error is fed back into
     * the same conversation as a message and the routing priority is bumped one level (see
     * AIVendorManager.bumpPriority), up to a small retry budget.
     * @param {string} targetDir - Directory the agent is allowed to write to.
     * @param {AIMessage[]} messages - Seed conversation (system + user), mutated in place.
     * @param {TokenManager} tokens - Injected by the caller so usage is tracked centrally.
     * @param {AgentRunOptions} options - priority (default 'mid'), maxIterations, maxTokens.
     * @returns {Promise<CodeAgentResult>}
     * @example
     * const messages = await prompts.build('ai-code', { task: prompt, tree }, targetDir);
     * const result = await aiContext.runCodeAgent(targetDir, messages, tokens, { priority: 'mid' });
     */
    public async runCodeAgent(
        targetDir: string,
        messages: AIMessage[],
        tokens: TokenManager,
        options: AgentRunOptions = {}
    ): Promise<CodeAgentResult> {
        let priority = options.priority ?? 'mid';
        const explorationRoot = this.computeExplorationRoot(targetDir);
        const ctx: AgentToolContext = { projectDir: targetDir, explorationRoot, ignoredDirs: DEFAULT_IGNORED_DIRS, seenFiles: new Set<string>() };

        let promptTokens = 0;
        let completionTokens = 0;
        let toolCallsUsed = 0;
        let lastContent = '';
        let filesChanged: string[] = [];
        let blockedWrites: string[] = [];
        let failedEdits: string[] = [];
        let fileDiffs: FileDiff[] = [];
        let validation: ValidationResult = { ran: false, ok: true };
        let sandboxResult: SandboxResult = { ran: false, ok: true };

        for (let attempt = 0; attempt <= MAX_SELF_HEAL_ATTEMPTS; attempt++) {
            const run = await this.runAgentLoop(messages, ctx, tokens, { ...options, priority });
            promptTokens += run.promptTokens;
            completionTokens += run.completionTokens;
            toolCallsUsed += run.toolCallsUsed;
            lastContent = run.content;

            const blocks = this.parsePatchBlocks(run.content);
            if (blocks.length === 0) break;

            const applied = await this.applyPatches(targetDir, blocks, ctx.seenFiles);
            filesChanged = applied.filesChanged;
            blockedWrites = applied.blockedWrites;
            failedEdits = applied.failedEdits;
            fileDiffs = applied.fileDiffs;
            if (filesChanged.length === 0) break;

            validation = await this.runValidation(targetDir);
            sandboxResult = validation.ok ? await this.sandbox.verify(targetDir) : { ran: false, ok: true };

            const stepFailed = !validation.ok || !sandboxResult.ok;
            if (!stepFailed || attempt === MAX_SELF_HEAL_ATTEMPTS) break;

            const nextPriority = this.ai.bumpPriority(priority);
            const failureLabel = !validation.ok ? 'compilation/lint' : `the sandbox check (${sandboxResult.command})`;
            const failureOutput = !validation.ok ? validation.output : sandboxResult.output;
            this.logger.warn(
                `Post-write ${failureLabel} failed (attempt ${attempt + 1}/${MAX_SELF_HEAL_ATTEMPTS + 1}); asking the model to fix it and bumping priority: ${priority} → ${nextPriority}`
            );
            priority = nextPriority;

            messages.push({ role: 'assistant', content: run.content });
            messages.push({
                role: 'user',
                content:
                    `SYSTEM: Your change broke ${failureLabel} with the following error:\n\n${failureOutput ?? '(no output captured)'}\n\n` +
                    'Fix it using more SEARCH/REPLACE blocks for the affected file(s). If you are not certain of a file\'s current ' +
                    'exact content after your previous edit, re-read it with read_file before writing a new SEARCH block against it.',
            });
        }

        return {
            content: lastContent,
            promptTokens,
            completionTokens,
            toolCallsUsed,
            priorityUsed: priority,
            filesChanged,
            blockedWrites,
            failedEdits,
            fileDiffs,
            validation,
            sandbox: sandboxResult,
        };
    }

    /**
     * @method runDescribeAgent
     * @description Runs the tool-use agent loop for ai:describe: no file writing, just exploration
     * (list_directory / read_file / read_manifest / etc.) and a final Markdown answer, which the
     * caller is responsible for writing to disk (the output filename is a command-layer policy,
     * not something this manager should decide).
     * @param {string} dir - Directory the agent is allowed to explore (read-only).
     * @param {AIMessage[]} messages - Seed conversation (system + user).
     * @param {TokenManager} tokens - Injected by the caller so usage is tracked centrally.
     * @param {AgentRunOptions} options - priority (default 'mid-low'), maxIterations, maxTokens.
     * @returns {Promise<AgentRunResult>}
     * @example
     * const messages = await prompts.build('ai-describe-project', { tree, readme }, projectDir);
     * const result = await aiContext.runDescribeAgent(projectDir, messages, tokens);
     * await fs.write(path.join(projectDir, 'AGENTS.md'), result.content.trim() + '\n');
     */
    public async runDescribeAgent(
        dir: string,
        messages: AIMessage[],
        tokens: TokenManager,
        options: AgentRunOptions = {}
    ): Promise<AgentRunResult> {
        const explorationRoot = this.computeExplorationRoot(dir);
        const ctx: AgentToolContext = { projectDir: dir, explorationRoot, ignoredDirs: DEFAULT_IGNORED_DIRS, seenFiles: new Set<string>() };
        return this.runAgentLoop(messages, ctx, tokens, { ...options, priority: options.priority ?? 'mid-low' });
    }
}

export const AIContextManagerTests = {
    findContextFiles: { dir: '~/Projects/TyrFramework' },
};
