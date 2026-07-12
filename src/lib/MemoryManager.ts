/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.memory`. A separate, complementary layer to
 * {@link AIContextManager}'s AGENTS.md/CLAUDE.md guidelines: where those are hand-curated,
 * long-lived project conventions, this class is an automatic, deterministic log of past AI
 * conversations a chat/code command can consult (`findRelevant()`/`getContextMessage()`) to ground
 * a reply on "what we actually did here before" — see this class's own doc comment for the full
 * design rationale (why everything here is deterministic, with no AI call).
 */
import path from 'path';
import crypto from 'crypto';
import { homedir } from 'os';
import yaml from 'js-yaml';

import { FileSystemManager } from './FileSystemManager.js';
import { Logger } from '../core/Logger.js';
import { AIMessage } from './AIVendorManager.js';
import { getEnvInt } from '../core/util/getenv.js';

export type MemoryCommand = 'ai:chat' | 'ai:code' | 'ai:describe';

export interface MemoryHistoryTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface MemoryConversationEntry {
    command: MemoryCommand;
    history: MemoryHistoryTurn[];
    filesChanged: string[];
}

export interface MemoryMatch {
    filePath: string;
    date: string;
    command: MemoryCommand;
    summary: string;
    score: number;
}

interface MemoryFrontmatter {
    project: string;
    date: string;
    command: MemoryCommand;
    filesChanged: string[];
    topics: string[];
}

const MIN_RELEVANCE_SCORE = getEnvInt('MEMORY_MIN_RELEVANCE_SCORE', 2);
const MAX_TOPICS = 12;
const MAX_TIMELINE_TURNS = 40;
const SUMMARY_EXCERPT_CHARS = 140;

// Small, deliberately conservative stopword set (EN + ES) — just enough to keep the most common
// filler words out of topic extraction, not a full NLP pipeline (see extractTopics()).
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'this', 'that', 'is',
    'are', 'was', 'were', 'be', 'been', 'it', 'as', 'at', 'by', 'from', 'not', 'but', 'you', 'your',
    'can', 'will', 'should', 'would', 'could', 'please', 'add', 'file', 'files',
    'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'que', 'en', 'con', 'para',
    'por', 'del', 'al', 'es', 'ser', 'está', 'esta', 'este', 'como', 'lo', 'se', 'su', 'sus', 'me',
    'te', 'le', 'les', 'quiero', 'quieres', 'puedes', 'archivo', 'archivos',
]);

function sanitizeSlugPart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function truncateText(text: string, maxChars: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

/** Word tokens (letters, 3+ chars) plus filename-like tokens (basename.ext) — the same style of
 *  cheap, deterministic tokenization used elsewhere in this codebase for mention detection. */
function tokenize(text: string): string[] {
    const words = (text.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? []).map((t) => t.toLowerCase());
    const fileTokens = (text.match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? []).map((t) => t.toLowerCase());
    return [...words.filter((t) => !STOPWORDS.has(t)), ...fileTokens];
}

function basenameNoExt(relPath: string): string {
    return path.basename(relPath, path.extname(relPath)).toLowerCase();
}

/** 100% deterministic — no AI call. Basenames of changed files always count as topics (highest
 *  signal); everything else is ranked by raw frequency across the conversation's text. */
function extractTopics(history: MemoryHistoryTurn[], filesChanged: string[]): string[] {
    const fileBasenames = filesChanged.map(basenameNoExt);
    const combinedText = history.map((h) => h.text).join(' ');

    const freq = new Map<string, number>();
    for (const token of tokenize(combinedText)) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
    }

    const ranked = [...freq.entries()]
        .filter(([token]) => !fileBasenames.includes(token))
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TOPICS)
        .map(([token]) => token);

    return [...new Set([...fileBasenames, ...ranked])];
}

function buildSummary(entry: MemoryConversationEntry): string {
    const filesLine = entry.filesChanged.length > 0 ? `Files changed: ${entry.filesChanged.join(', ')}.` : 'No files changed.';
    const firstUser = entry.history.find((h) => h.role === 'user');
    const lastUser = [...entry.history].reverse().find((h) => h.role === 'user');

    let messageLines = firstUser ? `First message: "${truncateText(firstUser.text, SUMMARY_EXCERPT_CHARS)}"` : '';
    if (lastUser && lastUser !== firstUser) {
        messageLines += ` Last message: "${truncateText(lastUser.text, SUMMARY_EXCERPT_CHARS)}"`;
    }

    return `${entry.history.length} message(s) exchanged. ${filesLine} ${messageLines}`.trim();
}

function buildTimeline(history: MemoryHistoryTurn[]): string {
    const capped = history.slice(0, MAX_TIMELINE_TURNS);
    const lines = capped.map((h) => `- ${h.role}: ${truncateText(h.text, 120)}`);
    if (history.length > MAX_TIMELINE_TURNS) {
        lines.push(`- (${history.length - MAX_TIMELINE_TURNS} earlier turn(s) omitted)`);
    }
    return lines.join('\n');
}

function parseFrontmatter(content: string): { data: MemoryFrontmatter; body: string } | null {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;
    try {
        const data = yaml.load(match[1]) as MemoryFrontmatter;
        if (!data || typeof data !== 'object') return null;
        return { data, body: match[2] };
    } catch {
        return null;
    }
}

function extractSummarySection(body: string): string {
    const match = body.match(/## Summary\n([\s\S]*?)(\n##|$)/);
    return match ? match[1].trim() : '';
}

/**
 * @class MemoryManager
 * @description Global, cross-session memory of past ai:chat/ai:code/ai:describe conversations,
 * stored as compacted Markdown files under ~/.tyr/.tyr-mem/<project-slug>/. Complements the
 * per-project AGENTS.md/CLAUDE.md guidelines (see AIContextManager.getContext()) with "what we
 * actually did here before" — grounded on real conversation history rather than hand-written docs.
 *
 * Both writing (recordConversation) and reading (findRelevant) are entirely deterministic — no AI
 * call anywhere in this class. Compaction is built from data the caller already has (message text,
 * files changed); retrieval is plain keyword-overlap scoring, scoped to the same project only, and
 * returns nothing below a relevance threshold. This is a deliberate cost control: memory should
 * only spend context-window tokens when it's actually likely to help, never as a blind dump.
 */
export class MemoryManager {
    private fs: FileSystemManager;
    private logger: Logger;
    /** Resolved once at construction (same convention as TokenManager's usageFile) — homedir() is
     *  read live at that point, so tests can point HOME elsewhere before constructing an instance. */
    private memoryRoot: string;

    constructor(fs: FileSystemManager, logger: Logger) {
        this.fs = fs;
        this.logger = logger;
        this.memoryRoot = path.join(homedir(), '.tyr', '.tyr-mem');
    }

    private projectSlug(projectDir: string): string {
        const resolved = path.resolve(projectDir);
        const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
        return `${sanitizeSlugPart(path.basename(resolved))}-${hash}`;
    }

    private projectMemoryDir(projectDir: string): string {
        return path.join(this.memoryRoot, this.projectSlug(projectDir));
    }

    /**
     * @method recordConversation
     * @description Compacts and writes a conversation to disk under this project's memory folder.
     * Compaction is entirely deterministic (turn count, files touched, truncated first/last
     * message, capped timeline) — never an extra AI call.
     * @param {string} projectDir - Absolute path to the project the conversation was about.
     * @param {MemoryConversationEntry} entry - What happened: command, turns, files changed.
     * @returns {Promise<string>} The path of the written memory file.
     * @example
     * await memory.recordConversation(targetDir, { command: 'ai:code', history, filesChanged });
     */
    public async recordConversation(projectDir: string, entry: MemoryConversationEntry): Promise<string> {
        const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
        const shortId = crypto.randomUUID().slice(0, 8);
        const filePath = path.join(this.projectMemoryDir(projectDir), `${isoStamp}-${shortId}.md`);

        const frontmatter: MemoryFrontmatter = {
            project: path.resolve(projectDir),
            date: new Date().toISOString(),
            command: entry.command,
            filesChanged: entry.filesChanged,
            topics: extractTopics(entry.history, entry.filesChanged),
        };

        const content =
            `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n\n` +
            `## Summary\n${buildSummary(entry)}\n\n` +
            `## Timeline\n${buildTimeline(entry.history)}\n`;

        await this.fs.write(filePath, content);
        return filePath;
    }

    /**
     * @method findRelevant
     * @description Scores every memory file for this project by deterministic keyword overlap
     * against `taskText`, returning only matches at or above a minimum relevance threshold — never
     * an unfiltered dump. No AI call. Scoped to this project only (no cross-project search in v1).
     * @param {string} projectDir - Absolute path to the project.
     * @param {string} taskText - The current message/task to find relevant past work for.
     * @param {number} limit - Max matches to return (default 3).
     * @returns {Promise<MemoryMatch[]>} Matches sorted by score desc, then date desc.
     * @example
     * const matches = await memory.findRelevant(targetDir, message.text);
     */
    public async findRelevant(projectDir: string, taskText: string, limit: number = 3): Promise<MemoryMatch[]> {
        const memoryDir = this.projectMemoryDir(projectDir);
        const fileNames = (await this.fs.readdir(memoryDir)).filter((name) => name.endsWith('.md'));
        if (fileNames.length === 0) return [];

        const queryTokens = new Set(tokenize(taskText));
        if (queryTokens.size === 0) return [];

        const matches: MemoryMatch[] = [];
        for (const fileName of fileNames) {
            const filePath = path.join(memoryDir, fileName);
            const content = await this.fs.read(filePath);
            if (!content) continue;

            const parsed = parseFrontmatter(content);
            if (!parsed) continue;

            const fileBasenames = new Set((parsed.data.filesChanged ?? []).map(basenameNoExt));
            let score = 0;
            for (const topic of parsed.data.topics ?? []) {
                if (queryTokens.has(topic)) score += fileBasenames.has(topic) ? 2 : 1;
            }
            if (score < MIN_RELEVANCE_SCORE) continue;

            matches.push({
                filePath,
                date: parsed.data.date,
                command: parsed.data.command,
                summary: extractSummarySection(parsed.body),
                score,
            });
        }

        return matches
            .sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1))
            .slice(0, limit);
    }

    /**
     * @method getContextMessage
     * @description Convenience wrapper mirroring AIContextManager.getContext()'s shape: a single
     * 'system' message ready to splice into a prompt, or `null` when nothing relevant was found —
     * so callers can skip it cheaply exactly like they already do for other optional context.
     * @param {string} projectDir - Absolute path to the project.
     * @param {string} taskText - The current message/task to find relevant past work for.
     * @returns {Promise<AIMessage | null>}
     * @example
     * const memoryMessage = await memory.getContextMessage(targetDir, message.text);
     * if (memoryMessage) messages.push(memoryMessage);
     */
    public async getContextMessage(projectDir: string, taskText: string): Promise<AIMessage | null> {
        const matches = await this.findRelevant(projectDir, taskText);
        if (matches.length === 0) return null;

        const sections = matches.map((m) => `### ${m.command} — ${m.date}\n${m.summary}`);
        return {
            role: 'system',
            content: `Relevant past work on this project (from memory):\n\n${sections.join('\n\n')}`,
        };
    }
}

/**
 * @object MemoryManagerTests
 * @description Test parameters to validate MemoryManager functionality.
 */
export const MemoryManagerTests = {};
