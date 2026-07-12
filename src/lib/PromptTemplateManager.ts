/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.prompts`. Sits between a command and {@link AIVendorManager}:
 * holds the library of named prompt templates (`DEFAULT_TEMPLATES` below) and fills their
 * `{{placeholders}}`, automatically prepending the project's guideline file via
 * {@link AIContextManager}'s `getContext()` (`build()`) or skipping that step for templates that
 * generate the guideline file itself (`buildStandalone()` — see its doc comment for why). A
 * command should build its `AIMessage[]` prompt through this class rather than hand-assembling
 * system/user messages, so every AI-backed command shares the same context-injection behaviour.
 */
import { AIContextManager, AGENT_TOOLS_DESCRIPTION, SEARCH_REPLACE_FORMAT_INSTRUCTIONS } from './AIContextManager.js';
import { AIMessage } from './AIVendorManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

export interface PromptTemplate {
    system: string;
    user: string;
}

const CODE_SYSTEM_PROMPT =
    "You are a senior software engineer working inside an existing project. You are given the project's " +
    'AGENTS.md (architecture and conventions) and its directory tree. Fulfil the user\'s request by ' +
    'creating new files and/or modifying existing ones as needed, following the project\'s existing ' +
    'conventions (naming, structure, style, imports) exactly as described in AGENTS.md. Regardless of the ' +
    "language used elsewhere in the project's existing code or comments, or the language of the user's " +
    'request, write ALL comments you add or rewrite (inline comments, JSDoc/docblocks, etc.) in English.\n\n' +
    'Before writing any new file that is supposed to follow an existing convention or pattern (e.g. "a ' +
    'command file", "a service class", any structure AGENTS.md only names without fully specifying), do ' +
    'not guess its exact shape from the name alone: find and read at least one real existing example of ' +
    'that pattern in the project first (list_directory / read_file / search_dependency_usage can help you ' +
    'locate one), and follow its structure precisely. If the pattern depends on a framework or library ' +
    'installed in the project and you are not certain of its exact API, do not assume — use ' +
    'read_dependency_manifest to locate it in node_modules and see its entry points, then ' +
    'list_dependency_files / read_dependency_file to read its real source or type definitions before you ' +
    'write code against it.\n\n' +
    SEARCH_REPLACE_FORMAT_INSTRUCTIONS +
    '\n\n' + AGENT_TOOLS_DESCRIPTION +
    " Do not assume the content of an existing file you need to modify that hasn't already been shown to " +
    'you: request it with read_file before writing a SEARCH block against it — a SEARCH snippet that does ' +
    "not match the file's real current content will simply fail to apply and that edit will be skipped.";

const PROJECT_DESCRIBE_SYSTEM_PROMPT =
    'You are a senior software architect writing a comprehensive AGENTS.md context file for an AI coding ' +
    "assistant that will work on this project. You are given the project's README (when present) — treat " +
    "it as a helpful guide to the project's intent and terminology, but not as the only source of truth, " +
    'since it may be incomplete or outdated — and the project file tree, for structural grounding only ' +
    '(an accurate tree will be appended to the document automatically after your response, so do not ' +
    'reproduce or reformat it yourself). Everything else about the codebase — file contents, the ' +
    "project's real dependencies, how they're used — is NOT included up front: request it yourself with " +
    'the available tools before writing. Produce a thorough, well-structured Markdown document that: ' +
    'describes the overall purpose of the project; walks through every directory and file, explaining ' +
    'what it does and what it is responsible for; documents the public API surface (exported classes, ' +
    'functions, types) of each module; and explains how the pieces fit together, so a newcomer AI ' +
    'assistant can safely make changes without missing context. Be exhaustive and specific to this ' +
    "codebase — do not include generic advice. Write the entire document in English, regardless of the " +
    "language used in the project's source code, comments, filenames, README, or file contents.\n\n" +
    AGENT_TOOLS_DESCRIPTION +
    ' When you have everything you need, respond ONLY with the final Markdown document, with no additional ' +
    'commentary or mentions of the tools you used.';

const FILE_DESCRIBE_SYSTEM_PROMPT =
    'You are a senior software architect writing an AGENTS.md-style context file for a single source ' +
    'file, meant to be read by an AI coding assistant before it edits that file. You may also be given ' +
    "the project's README and/or its existing AGENTS.md for overall context — use them to align " +
    'terminology and to note how this file fits into the broader project, without repeating what they ' +
    'already cover. Produce a thorough, well-structured Markdown document that: describes what the file ' +
    'does end-to-end; documents every exported class, function, type and constant, what it is ' +
    "responsible for, and how it is meant to be used; and calls out any non-obvious behaviour, edge " +
    'cases or invariants a future editor needs to know. Be exhaustive and specific to this file — do not ' +
    'include generic advice. Write the entire document in English, regardless of the language used in ' +
    "the file's own code, comments, or the project's README/AGENTS.md.\n\n" +
    AGENT_TOOLS_DESCRIPTION +
    ' When you have everything you need, respond ONLY with the final Markdown document, with no additional ' +
    'commentary or mentions of the tools you used.';

const DEFAULT_TEMPLATES: Record<string, PromptTemplate> = {
    'analyze-bug': {
        system:
            'You are a senior software engineer specialised in debugging. Analyse the given code and ' +
            'describe the root cause of the bug, then propose a minimal, correct fix. Be precise and ' +
            'reference exact lines when possible.',
        user: 'Bug description:\n{{description}}\n\nRelevant code:\n```\n{{code}}\n```',
    },
    'generate-command': {
        system:
            'You are a senior TypeScript engineer generating a Tyr Framework command. Follow the ' +
            'existing conventions exactly: dependency injection via TyrContext, TyrError for failures, ' +
            'JSDoc comments on public methods. Output only the TypeScript code for the file, no commentary.',
        user: 'Command name: {{name}}\nRequested behaviour:\n{{description}}',
    },
    'generate-code': {
        system:
            'You are a senior engineer. Follow the ' +
            'existing conventions exactly: KISS, SOLID, DRY. Only make simple comments on the functions to give context if is necessary ' +
            'Output only the code for the file, no commentary.',
        user: 'Command name: {{name}}\nRequested behaviour:\n{{description}}',
    },
    'explain-code': {
        system:
            'You are a senior software engineer. Explain what the given code does clearly and ' +
            'concisely, for a developer unfamiliar with it.',
        user: 'Code:\n```\n{{code}}\n```',
    },
    'refactor-code': {
        system:
            'You are a senior software engineer. Refactor the given code for clarity and ' +
            'maintainability without changing its behaviour. Explain the key changes briefly, then ' +
            'provide the full refactored code.',
        user: 'Code:\n```\n{{code}}\n```\n\nGoal:\n{{goal}}',
    },
    // Used by the ai:code command. AGENTS.md is prepended automatically by build() (via
    // AIContextManager.getContext) — {{tree}} is the only extra context seeded up front; the
    // agent pulls in any specific file it needs itself via AGENT_TOOLS (see AIContextManager).
    'ai-code': {
        system: CODE_SYSTEM_PROMPT,
        user: '# Project structure\n```\n{{tree}}\n```\n\n# Task\n{{task}}',
    },
    // Used by the ai:describe command when generating AGENTS.md for a whole project. Intentionally
    // built with buildStandalone() rather than build(): forcing a guidelines file to exist before
    // we've generated one yet would be circular.
    'ai-describe-project': {
        system: PROJECT_DESCRIBE_SYSTEM_PROMPT,
        user: '{{readme}}\n\n# Project structure\n```\n{{tree}}\n```',
    },
    // Used by the ai:describe command when describing a single file.
    'ai-describe-file': {
        system: FILE_DESCRIBE_SYSTEM_PROMPT,
        user: 'File path (relative to the project): {{path}}\nFile content:\n```\n{{content}}\n```\n\n{{context}}',
    },
};

/**
 * @class PromptTemplateManager
 * @description Manages the system's prompt templates. Exposes a base template for common tasks
 * (analysing a bug, generating a command, explaining or refactoring code) and fills in the
 * placeholders with the user's code and the project context, so the AI always receives its role
 * instructions in a uniform way.
 */
export class PromptTemplateManager {
    private context: AIContextManager;
    private logger: Logger;
    private templates: Record<string, PromptTemplate>;

    constructor(context: AIContextManager, logger: Logger) {
        this.context = context;
        this.logger = logger;
        this.templates = { ...DEFAULT_TEMPLATES };
    }

    /**
     * @method listTemplates
     * @description Lists the names of all registered prompt templates.
     * @returns {string[]} Template names.
     * @example
     * const names = prompts.listTemplates();
     * // ['analyze-bug', 'generate-command', 'explain-code', 'refactor-code']
     */
    public listTemplates(): string[] {
        return Object.keys(this.templates);
    }

    /**
     * @method registerTemplate
     * @description Registers a new prompt template, or overrides an existing one.
     * @param {string} name - Unique template name.
     * @param {PromptTemplate} template - The system role instructions and the user template string.
     * @example
     * prompts.registerTemplate('write-tests', {
     *   system: 'You are a senior QA engineer...',
     *   user: 'Code:\n```\n{{code}}\n```',
     * });
     */
    public registerTemplate(name: string, template: PromptTemplate): void {
        this.templates[name] = template;
    }

    /** Substitutes `{{key}}` placeholders in `template` with values from `vars`. Throws a
     *  {@link TyrError} on a placeholder with no matching value, rather than leaving the literal
     *  `{{key}}` text in the prompt sent to the model. */
    private fill(template: string, vars: Record<string, string>): string {
        return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => {
            if (!(key in vars)) {
                throw new TyrError(
                    `Missing placeholder value: '${key}'`,
                    null,
                    `Provide a value for '${key}' when building this prompt.`
                );
            }
            return vars[key];
        });
    }

    /**
     * @method build
     * @description Fills a named template with the given variables and prepends the project's
     * context (see AIContextManager), producing the full list of messages ready to send to
     * AIVendorManager.
     * @param {string} templateName - Name of a registered template (see listTemplates()).
     * @param {Record<string,string>} vars - Values for the template's {{placeholders}}.
     * @param {string} projectDir - Absolute path to the project root, used to load its context.
     * @returns {Promise<AIMessage[]>} Ordered messages: [system, ...context, user].
     * @example
     * const messages = await prompts.build('analyze-bug', {
     *   description: 'Login fails with a 500 error',
     *   code: fileContent,
     * }, process.cwd());
     * const result = await ai.complete(messages);
     */
    public async build(templateName: string, vars: Record<string, string>, projectDir: string): Promise<AIMessage[]> {
        const template = this.templates[templateName];
        if (!template) {
            throw new TyrError(
                `Unknown prompt template: '${templateName}'`,
                null,
                `Available templates: ${this.listTemplates().join(', ')}`
            );
        }

        const systemMessage: AIMessage = { role: 'system', content: template.system };
        const userMessage: AIMessage = { role: 'user', content: this.fill(template.user, vars) };
        const contextMessages = await this.context.getContext(projectDir);

        return [systemMessage, ...contextMessages, userMessage];
    }

    /**
     * @method buildStandalone
     * @description Like build(), but does NOT prepend the project's guidelines file — use this
     * when the template itself is what generates that file (e.g. 'ai-describe-project', the very
     * first run on a project with no AGENTS.md yet), where calling getContext() would force a
     * separate, redundant guidelines generation first.
     * @param {string} templateName - Name of a registered template (see listTemplates()).
     * @param {Record<string,string>} vars - Values for the template's {{placeholders}}.
     * @returns {AIMessage[]} Ordered messages: [system, user].
     * @example
     * const messages = prompts.buildStandalone('ai-describe-project', { tree, readme });
     * const result = await aiContext.runDescribeAgent(projectDir, messages, tokens);
     */
    public buildStandalone(templateName: string, vars: Record<string, string>): AIMessage[] {
        const template = this.templates[templateName];
        if (!template) {
            throw new TyrError(
                `Unknown prompt template: '${templateName}'`,
                null,
                `Available templates: ${this.listTemplates().join(', ')}`
            );
        }

        return [
            { role: 'system', content: template.system },
            { role: 'user', content: this.fill(template.user, vars) },
        ];
    }
}

export const PromptTemplateManagerTests = {
    listTemplates: {},
};
