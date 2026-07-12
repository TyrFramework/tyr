/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.tokens`. Cost/size guardrail sitting alongside
 * {@link AIVendorManager}: estimates a prompt's token cost before it's sent (`assertWithinLimit()`)
 * and records actual usage after a call completes (`recordUsage()`), so AI-backed commands can
 * cheaply guard against oversized requests and later answer "how much have I spent" via
 * `getUsageStats()`. All estimates are a fast character-count heuristic, not a real vendor
 * tokenizer — see the class doc for why that's an acceptable trade-off here.
 */
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

import { AIMessage, AIContentBlock } from './AIVendorManager.js';
import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';
import { getEnvInt } from '../core/util/getenv.js';

const DEFAULT_MAX_INPUT_TOKENS = getEnvInt('DEFAULT_MAX_INPUT_TOKENS', 100000);
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

interface UsageEntry {
    timestamp: string;
    vendor: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
}

export interface UsageStats {
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
}

/**
 * @class TokenManager
 * @description Controls AI token consumption and limits. Estimates the token cost of a prompt
 * before it is sent (to avoid oversized requests or runaway costs), records real usage once a
 * request completes, and reports aggregated statistics. The estimate is a fast heuristic
 * (~4 characters per token), not an exact vendor tokenizer, so it should be treated as an
 * upper-bound guard rather than a billing-accurate figure.
 */
export class TokenManager {
    private logger: Logger;
    private usageFile: string;

    constructor(logger: Logger) {
        this.logger = logger;
        this.usageFile = path.join(homedir(), '.tyr', 'logs', 'ai-usage.jsonl');
    }

    /**
     * @method estimateTokens
     * @description Estimates the number of tokens a piece of text will consume.
     * @param {string} text - The text to estimate.
     * @returns {number} Estimated token count.
     * @example
     * const tokens = tokens_.estimateTokens(fileContent);
     */
    public estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * @method contentToText
     * @description Flattens an AIMessage's content — a plain string, or an AIContentBlock[] as
     * used by the tool-use agent loop (text / tool_use / tool_result / image blocks) — into a
     * single string for estimation purposes. Non-text blocks contribute an approximate stand-in
     * length (JSON-stringified input/content) rather than being ignored, so a message full of
     * large tool_result blocks isn't silently under-counted.
     * @param {string | AIContentBlock[]} content - The raw content of an AIMessage.
     * @returns {string} Flattened text.
     * @example
     * const text = tokens_.contentToText(message.content);
     */
    public contentToText(content: string | AIContentBlock[]): string {
        if (typeof content === 'string') return content;

        return content
            .map((block) => {
                switch (block.type) {
                    case 'text': return block.text;
                    case 'tool_use': return JSON.stringify(block.input ?? {});
                    case 'tool_result': return block.content;
                    case 'image': return ''; // billed very differently from text; excluded from the char-based heuristic
                    default: return '';
                }
            })
            .join('\n');
    }

    /**
     * @method estimateMessagesTokens
     * @description Estimates the total token cost of a full list of prompt messages.
     * @param {AIMessage[]} messages - Messages that would be sent to AIVendorManager.
     * @returns {number} Estimated total token count, including a small per-message overhead.
     * @example
     * const total = tokens_.estimateMessagesTokens(messages);
     */
    public estimateMessagesTokens(messages: AIMessage[]): number {
        return messages.reduce(
            (total, m) => total + this.estimateTokens(this.contentToText(m.content)) + PER_MESSAGE_OVERHEAD_TOKENS,
            0
        );
    }

    /**
     * @method assertWithinLimit
     * @description Stops execution with an error if the estimated prompt size exceeds the given
     * limit (or the default of 100,000 tokens). Call this before sending a prompt to AIVendorManager.
     * @param {AIMessage[]} messages - Messages that would be sent to AIVendorManager.
     * @param {number} limit - Maximum allowed estimated tokens (default: 100000).
     * @example
     * tokens_.assertWithinLimit(messages);
     * const result = await ai.complete(messages);
     */
    public assertWithinLimit(messages: AIMessage[], limit: number = DEFAULT_MAX_INPUT_TOKENS): void {
        const estimated = this.estimateMessagesTokens(messages);
        if (estimated > limit) {
            throw new TyrError(
                `Estimated prompt size (${estimated} tokens) exceeds the limit (${limit} tokens).`,
                null,
                'Provide a smaller context (fewer or shorter files) or split the task into smaller steps.'
            );
        }
    }

    /**
     * @method recordUsage
     * @description Appends a usage record for a completed AI request, for later reporting.
     * @param {string} vendor - Vendor name used (e.g. 'anthropic').
     * @param {string} model - Model name used.
     * @param {number} promptTokens - Prompt tokens consumed (from the vendor's response, if available).
     * @param {number} completionTokens - Completion tokens consumed (from the vendor's response, if available).
     * @example
     * const result = await ai.complete(messages);
     * tokens_.recordUsage(result.vendor, result.model, result.promptTokens ?? 0, result.completionTokens ?? 0);
     */
    public recordUsage(vendor: string, model: string, promptTokens: number, completionTokens: number): void {
        const entry: UsageEntry = {
            timestamp: new Date().toISOString(),
            vendor,
            model,
            promptTokens,
            completionTokens,
        };
        try {
            fs.mkdirSync(path.dirname(this.usageFile), { recursive: true });
            fs.appendFileSync(this.usageFile, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (e) {
            this.logger.warn(`Could not record AI token usage: ${(e as Error).message}`);
        }
    }

    /**
     * @method getUsageStats
     * @description Reads the recorded usage log and returns aggregated statistics, overall and
     * broken down by vendor/model.
     * @returns {Promise<UsageStats>} Aggregated usage statistics.
     * @example
     * const stats = await tokens_.getUsageStats();
     * logger.info(`Total tokens used: ${stats.totalPromptTokens + stats.totalCompletionTokens}`);
     */
    public async getUsageStats(): Promise<UsageStats> {
        const stats: UsageStats = {
            totalCalls: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            byModel: {},
        };

        if (!fs.existsSync(this.usageFile)) return stats;

        const lines = fs.readFileSync(this.usageFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const entry: UsageEntry = JSON.parse(line);
                stats.totalCalls += 1;
                stats.totalPromptTokens += entry.promptTokens;
                stats.totalCompletionTokens += entry.completionTokens;

                const key = `${entry.vendor}/${entry.model}`;
                if (!stats.byModel[key]) {
                    stats.byModel[key] = { calls: 0, promptTokens: 0, completionTokens: 0 };
                }
                stats.byModel[key].calls += 1;
                stats.byModel[key].promptTokens += entry.promptTokens;
                stats.byModel[key].completionTokens += entry.completionTokens;
            } catch {
                // Skip malformed lines rather than failing the whole report.
            }
        }

        return stats;
    }
}

export const TokenManagerTests = {
    estimateTokens: { text: 'Hello world, this is a test string for token estimation.' },
    estimateMessagesTokens: { messages: [{ role: 'user', content: 'Hello world' }] },
    assertWithinLimit: { messages: [{ role: 'user', content: 'Hello world' }] },
};
