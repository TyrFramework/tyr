/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.aiVendor`. The lowest layer of Tyr's AI stack — the only class in
 * the codebase that actually calls an AI vendor's HTTP API (Anthropic/OpenAI/Gemini), and the only
 * one that knows each vendor's specific request/response shape. Everything above it works in
 * vendor-agnostic terms (`AIMessage`, `AIContentBlock`, `TaskPriority`):
 * {@link AIContextManager} builds prompts and runs the tool-use agent loop through it,
 * {@link PromptTemplateManager} fills prompt templates that get sent through it, and `sys/chat.ts`
 * routes chat replies through it. NOTE: some type-level doc comments in this file (e.g. on
 * `AIContentBlock`, `ThinkingEffort`) are written in Spanish rather than English — left as-is
 * (comments only, no rewrites in scope here) but worth normalising for consistency with the rest
 * of the codebase.
 */
import axios from 'axios';

import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

import {getEnvString, getEnvInt, getEnvDouble} from '../core/util/getenv.js';

export type AIVendor = 'anthropic' | 'openai' | 'gemini';
export type AIRole = 'system' | 'user' | 'assistant';

/**
 * Representación normalizada (independiente del vendor) del contenido de un mensaje.
 *
 *  - 'text': texto plano.
 *  - 'tool_use': el modelo pide ejecutar una herramienta. `id` es opaco para el llamador: hay
 *    que devolverlo tal cual en el `tool_result` correspondiente, sin asumir nada sobre su
 *    formato (en Gemini, por ejemplo, es un id sintético generado por este manager, ya que la
 *    API de Gemini no da ids reales para las function calls).
 *  - 'tool_result': resultado de haber ejecutado una herramienta, para devolvérselo al modelo.
 *  - 'image': imagen adjunta (p.ej. un attachment de chat). `data` es el contenido en base64 SIN
 *    el prefijo `data:...;base64,`; `mediaType` es el MIME type (p.ej. 'image/png'). Solo válido
 *    en mensajes de rol 'user' — los vendors no devuelven imágenes en sus respuestas.
 */
export type AIContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: any }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
    | { type: 'image'; mediaType: string; data: string };

export interface AIMessage {
    role: AIRole;
    /** Texto plano, o una lista de bloques cuando el mensaje incluye tool_use / tool_result. */
    content: string | AIContentBlock[];
}

/** Definición de herramienta en formato JSON-schema al estilo Anthropic; se traduce internamente
 *  al formato de cada vendor (function-calling de OpenAI, functionDeclarations de Gemini). */
export interface AITool {
    name: string;
    description: string;
    input_schema: any;
}

/**
 * Nivel de "esfuerzo de razonamiento" (extended thinking) pedido al modelo, independiente del
 * vendor concreto. Se traduce a `thinking.budget_tokens` en Anthropic, a
 * `generationConfig.thinkingConfig.thinkingBudget` en Gemini 2.5+ (mismo concepto de presupuesto
 * de tokens que Anthropic) y a `reasoning_effort` en los modelos de OpenAI que lo soportan (serie
 * 'o'), que solo acepta un vocabulario fijo (low/medium/high) en lugar de un número de tokens.
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

/** Prioridad de una tarea, usada por resolvePriority()/completeWithPriority() para elegir modelo
 *  y esfuerzo de razonamiento sin que el llamador tenga que conocer nombres de modelo concretos. */
export type TaskPriority =
    | 'baja-prioridad'
    | 'baja-media-prioridad'
    | 'media-prioridad'
    | 'media-alta-prioridad'
    | 'alta-prioridad'
    | 'muy-alta-prioridad';

export interface AICompletionOptions {
    vendor?: AIVendor;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    maxRetries?: number;
    /** Herramientas disponibles para que el modelo las invoque. Solo soportado en complete(),
     *  no en stream() — ver el guard al inicio de stream(). */
    tools?: AITool[];
    /** Nivel de extended thinking / reasoning effort. Ver ThinkingEffort. 'none' (o ausente)
     *  desactiva el thinking explícitamente. */
    thinking?: ThinkingEffort;
}

export interface AICompletionResult {
    /** Texto plano concatenado de todos los bloques de tipo 'text' (conveniencia; equivalente al
     *  comportamiento anterior de esta clase, antes de soportar tools). */
    content: string;
    /** Contenido completo y normalizado, incluyendo bloques tool_use si el modelo pidió alguno.
     *  Necesario para reconstruir el mensaje de assistant en el siguiente turno de un bucle
     *  agente. */
    blocks: AIContentBlock[];
    vendor: AIVendor;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    /** Motivo de parada normalizado tal como lo reporta cada vendor (stop_reason / finish_reason
     *  / finishReason), sin normalizar entre vendors — úsalo solo informativamente. */
    stopReason?: string;
}

interface VendorConfig {
    vendor: AIVendor;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    maxRetries: number;
    thinking: ThinkingEffort;
}

interface VendorRequest {
    url: string;
    headers: Record<string, string>;
    body: any;
}

const DEFAULT_MODELS: Record<AIVendor, string> = {
    anthropic: 'claude-sonnet-5',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.5-flash',
};

const API_KEY_ENV: Record<AIVendor, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
};

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// --- Dynamic Model Routing ----------------------------------------------------------------------
//
// Three cost/capability tiers per vendor. Each is overridable via env var (AI_MODEL_CHEAP /
// AI_MODEL_BALANCED / AI_MODEL_FLAGSHIP) so operators can point a tier at a newer model without
// touching code. 'balanced' matches DEFAULT_MODELS on purpose — it's the vendor's normal default.
type ModelTier = 'cheap' | 'balanced' | 'flagship';


const MODEL_TIER_ENV: Record<AIVendor, Record<ModelTier, string>> = {
    anthropic: { cheap: 'ANTHROPIC_AI_MODEL_CHEAP', balanced: 'ANTHROPIC_AI_MODEL_BALANCED', flagship: 'ANTHROPIC_AI_MODEL_FLAGSHIP' },
    openai: { cheap: 'OPENAI_AI_MODEL_CHEAP', balanced: 'OPENAI_AI_MODEL_BALANCED', flagship: 'OPENAI_AI_MODEL_FLAGSHIP' },
    gemini: { cheap: 'GEMINI_AI_MODEL_CHEAP', balanced: 'GEMINI_AI_MODEL_BALANCED', flagship: 'GEMINI_AI_MODEL_FLAGSHIP' },
};


const MODEL_TIER_DEFAULT: Record<string,string> = {
    anthropic: 'claude-haiku-4-5-20251001',
    openai: 'gpt-4o-mini-2024-07-18',
    gemini: 'gemini-2.5-flash-lite',
   };

/** budget_tokens sent to Anthropic's `thinking` param per effort level. 'none' disables thinking.
 *  Each is overridable via env var (see ANTHROPIC_THINKING_BUDGET_ENV); these are the fallback
 *  values used when the corresponding env var is not set. */
const ANTHROPIC_THINKING_BUDGETS: Record<ThinkingEffort, number> = {
    none: 0,
    low: 1024,
    medium: 4096,
    high: 8192,
    max: 16384,
};

const ANTHROPIC_THINKING_BUDGET_ENV: Record<ThinkingEffort, string> = {
    none: 'ANTHROPIC_THINKING_BUDGET_NONE',
    low: 'ANTHROPIC_THINKING_BUDGET_LOW',
    medium: 'ANTHROPIC_THINKING_BUDGET_MEDIUM',
    high: 'ANTHROPIC_THINKING_BUDGET_HIGH',
    max: 'ANTHROPIC_THINKING_BUDGET_MAX',
};

/** Gemini 2.5+'s `generationConfig.thinkingConfig.thinkingBudget` is the same token-budget concept
 *  as Anthropic's, so it reuses the same default magnitudes — overridable independently via its
 *  own env vars since Gemini's actual valid range differs by model (flash allows 0, pro doesn't). */
const GEMINI_THINKING_BUDGETS: Record<ThinkingEffort, number> = {
    none: 0,
    low: 1024,
    medium: 4096,
    high: 8192,
    max: 16384,
};

const GEMINI_THINKING_BUDGET_ENV: Record<ThinkingEffort, string> = {
    none: 'GEMINI_THINKING_BUDGET_NONE',
    low: 'GEMINI_THINKING_BUDGET_LOW',
    medium: 'GEMINI_THINKING_BUDGET_MEDIUM',
    high: 'GEMINI_THINKING_BUDGET_HIGH',
    max: 'GEMINI_THINKING_BUDGET_MAX',
};

function resolveThinkingBudget(
    effort: ThinkingEffort,
    defaults: Record<ThinkingEffort, number>,
    env: Record<ThinkingEffort, string>
): number {
    return getEnvInt(env[effort], defaults[effort]);
}

/** OpenAI's reasoning models (serie 'o', gpt-5*) solo aceptan un vocabulario fijo para
 *  `reasoning_effort` — no un número de tokens — así que aquí se mapea ThinkingEffort a esas
 *  cadenas en lugar de a un budget. 'none' está ausente a propósito: esos modelos no permiten
 *  desactivar el razonamiento, así que ThinkingEffort 'none' simplemente omite el parámetro
 *  (ver openaiReasoningFields). Cada nivel es overridable vía env var por si OpenAI cambia el
 *  vocabulario aceptado (p.ej. añade 'minimal') sin tener que tocar código. */
const OPENAI_REASONING_EFFORTS: Partial<Record<ThinkingEffort, string>> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'high',
};

const OPENAI_REASONING_EFFORT_ENV: Partial<Record<ThinkingEffort, string>> = {
    low: 'OPENAI_REASONING_EFFORT_LOW',
    medium: 'OPENAI_REASONING_EFFORT_MEDIUM',
    high: 'OPENAI_REASONING_EFFORT_HIGH',
    max: 'OPENAI_REASONING_EFFORT_MAX',
};

function resolveOpenAIReasoningEffort(effort: ThinkingEffort): string | undefined {
    const envVar = OPENAI_REASONING_EFFORT_ENV[effort];
    const override = envVar ? getEnvString(envVar) : undefined;
    return override ?? OPENAI_REASONING_EFFORTS[effort];
}

/**
 * Task-priority → (model tier, thinking effort) matrix. This is the routing table requested by
 * the architecture spec: callers pick a priority by *intent* ("this is a trivial file", "this
 * previous attempt failed"), not by model name, and AIVendorManager decides what that costs.
 * Each entry is overridable via env var (see PRIORITY_ROUTING_ENV); these are the fallback values
 * used when the corresponding env var is unset or holds an invalid tier/thinking value.
 */
const PRIORITY_ROUTING: Record<TaskPriority, { tier: ModelTier; thinking: ThinkingEffort }> = {
    'baja-prioridad': { tier: 'cheap', thinking: 'none' },
    'baja-media-prioridad': { tier: 'cheap', thinking: 'high' },
    'media-prioridad': { tier: 'balanced', thinking: 'none' },
    'media-alta-prioridad': { tier: 'balanced', thinking: 'high' },
    'alta-prioridad': { tier: 'balanced', thinking: 'max' },
    'muy-alta-prioridad': { tier: 'flagship', thinking: 'max' },
};

const PRIORITY_ROUTING_ENV: Record<TaskPriority, { tier: string; thinking: string }> = {
    'baja-prioridad': { tier: 'AI_PRIORITY_BAJA_TIER', thinking: 'AI_PRIORITY_BAJA_THINKING' },
    'baja-media-prioridad': { tier: 'AI_PRIORITY_BAJA_MEDIA_TIER', thinking: 'AI_PRIORITY_BAJA_MEDIA_THINKING' },
    'media-prioridad': { tier: 'AI_PRIORITY_MEDIA_TIER', thinking: 'AI_PRIORITY_MEDIA_THINKING' },
    'media-alta-prioridad': { tier: 'AI_PRIORITY_MEDIA_ALTA_TIER', thinking: 'AI_PRIORITY_MEDIA_ALTA_THINKING' },
    'alta-prioridad': { tier: 'AI_PRIORITY_ALTA_TIER', thinking: 'AI_PRIORITY_ALTA_THINKING' },
    'muy-alta-prioridad': { tier: 'AI_PRIORITY_MUY_ALTA_TIER', thinking: 'AI_PRIORITY_MUY_ALTA_THINKING' },
};

const VALID_MODEL_TIERS: ModelTier[] = ['cheap', 'balanced', 'flagship'];
const VALID_THINKING_EFFORTS: ThinkingEffort[] = ['none', 'low', 'medium', 'high', 'max'];

/** Resolves the (tier, thinking) route for a priority, letting env vars override either half of
 *  PRIORITY_ROUTING independently. An env var holding anything other than a valid tier/thinking
 *  value is ignored in favor of the hardcoded default, rather than passed through to the vendor. */
function resolvePriorityRoute(priority: TaskPriority): { tier: ModelTier; thinking: ThinkingEffort } {
    const defaults = PRIORITY_ROUTING[priority];
    const envVars = PRIORITY_ROUTING_ENV[priority];

    const tierOverride = getEnvString(envVars.tier)?.toLowerCase() as ModelTier | undefined;
    const thinkingOverride = getEnvString(envVars.thinking)?.toLowerCase() as ThinkingEffort | undefined;

    return {
        tier: tierOverride && VALID_MODEL_TIERS.includes(tierOverride) ? tierOverride : defaults.tier,
        thinking: thinkingOverride && VALID_THINKING_EFFORTS.includes(thinkingOverride) ? thinkingOverride : defaults.thinking,
    };
}

/** Ordered priority ladder, used by bumpPriority() to escalate one level at a time and by
 *  clampPriority() to enforce an optional ceiling. Exported so callers (e.g. a chat UI's effort
 *  selector) can list the valid levels without hardcoding them. */
export const TASK_PRIORITIES: TaskPriority[] = [
    'baja-prioridad',
    'baja-media-prioridad',
    'media-prioridad',
    'media-alta-prioridad',
    'alta-prioridad',
    'muy-alta-prioridad',
];

/**
 * @class AIVendorManager
 * @description Unified client for AI chat-completion APIs (Anthropic, OpenAI, Gemini).
 * Resolves the API key and technical defaults (model, temperature, max tokens) from
 * environment variables / Tyr configuration, retries transient failures with exponential
 * backoff, and supports both blocking and streaming responses.
 *
 * Tool use (function calling) is supported in `complete()` for all three vendors, behind a
 * vendor-agnostic representation (`AITool` / `AIContentBlock`). Each vendor's wire format is
 * different — this class does the translation both ways (request and response) so callers never
 * need to know which vendor is active. `stream()` does not support tools yet (see the guard at
 * the top of that method).
 *
 * Environment variables:
 *   AI_VENDOR          – 'anthropic' | 'openai' | 'gemini' (default: 'anthropic')
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY – API key for the selected vendor
 *   AI_MODEL           – overrides the vendor's default model
 *   AI_TEMPERATURE     – overrides the default temperature (0.3)
 *   AI_MAX_TOKENS      – overrides the default max output tokens (4096)
 *   AI_MAX_RETRIES     – overrides the default retry count (3)
 */
export class AIVendorManager {
    private logger: Logger;
    private priorityCeilingOverride: TaskPriority | null = null;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    private resolveConfig(options?: AICompletionOptions): VendorConfig {
        const vendor = (options?.vendor ?? (getEnvString('AI_VENDOR') as AIVendor | undefined) ?? 'anthropic')
            .toString()
            .toLowerCase() as AIVendor;

        if (!DEFAULT_MODELS[vendor]) {
            throw new TyrError(
                `Unsupported AI vendor: '${vendor}'`,
                null,
                `Set AI_VENDOR to one of: ${Object.keys(DEFAULT_MODELS).join(', ')}`
            );
        }

        const apiKey = getEnvString(API_KEY_ENV[vendor]);
        if (!apiKey) {
            throw new TyrError(
                `Missing API key for vendor '${vendor}'`,
                null,
                `Set ${API_KEY_ENV[vendor]} in ~/.tyr/.env`
            );
        }

        return {
            vendor,
            apiKey,
            model: options?.model ?? getEnvString('AI_MODEL') ?? DEFAULT_MODELS[vendor],
            temperature: options?.temperature ?? getEnvDouble('AI_TEMPERATURE', DEFAULT_TEMPERATURE),
            maxTokens: options?.maxTokens ?? getEnvInt('AI_MAX_TOKENS', DEFAULT_MAX_TOKENS),
            maxRetries: options?.maxRetries ?? getEnvInt('AI_MAX_RETRIES', DEFAULT_MAX_RETRIES),
            thinking: options?.thinking ?? 'none',
        };
    }

    /** Logged right before every outgoing request (complete() and stream()) — the one choke point
     *  all commands funnel through — so which model handled which call is always visible, without
     *  every caller having to remember to log it themselves. */
    private logModelUsage(config: VendorConfig): void {
        const thinkingSuffix = config.thinking && config.thinking !== 'none' ? `, thinking: ${config.thinking}` : '';
        this.logger.info(`[AI] Using ${config.vendor}/${config.model}${thinkingSuffix}`);
    }

    /**
     * @method resolvePriority
     * @description Translates a TaskPriority into concrete AICompletionOptions (model + thinking
     * effort) for the currently configured vendor (or the vendor passed in `overrides`), via the
     * routing matrix in PRIORITY_ROUTING. This is the single place that maps "how important/hard
     * is this task" to "which model do we pay for" — Manager code should route through this
     * instead of hardcoding model names.
     * @param {TaskPriority} priority - One of the six priority levels (see TaskPriority).
     * @param {AICompletionOptions} overrides - Optional overrides merged on top (e.g. tools, maxTokens).
     * @returns {AICompletionOptions} Options ready to pass to complete()/stream().
     * @example
     * const options = aiVendor.resolvePriority('media-alta-prioridad', { tools: AGENT_TOOLS });
     * const result = await aiVendor.complete(messages, options);
     */
    public resolvePriority(priority: TaskPriority, overrides: AICompletionOptions = {}): AICompletionOptions {
        const vendor = (overrides.vendor ?? (getEnvString('AI_VENDOR') as AIVendor | undefined) ?? 'anthropic')
            .toString()
            .toLowerCase() as AIVendor;

        if (!PRIORITY_ROUTING[priority]) {
            throw new TyrError(`Unknown task priority: '${priority}'`, null, `Use one of: ${TASK_PRIORITIES.join(', ')}`);
        }
        const route = resolvePriorityRoute(this.clampPriority(priority));

        const tierModel = getEnvString(MODEL_TIER_ENV[vendor][route.tier], MODEL_TIER_DEFAULT[vendor]);

        return {
            vendor,
            model: tierModel,
            thinking: route.thinking,
            ...overrides,
        };
    }

    /**
     * @method bumpPriority
     * @description Escalates a priority one level up the ladder (baja-prioridad → ... →
     * muy-alta-prioridad), capping at the top. Used for self-healing retries: each consecutive
     * failure (e.g. a broken compile after an applied patch) buys the model more capability.
     * @param {TaskPriority} priority - The current priority.
     * @returns {TaskPriority} The next priority level, or the same value if already at the top.
     * @example
     * priority = aiVendor.bumpPriority(priority); // one more level of thinking/model tier
     */
    public bumpPriority(priority: TaskPriority): TaskPriority {
        const index = TASK_PRIORITIES.indexOf(priority);
        if (index === -1 || index === TASK_PRIORITIES.length - 1) return priority;
        return this.clampPriority(TASK_PRIORITIES[index + 1]);
    }

    /**
     * @method setPriorityCeiling
     * @description Sets (or clears, with `null`) an upper bound no resolved priority may ever
     * exceed for this instance — including self-healing escalations via bumpPriority(). Meant for
     * a developer-controlled cap (e.g. a chat UI's effort selector) so the model can never reach
     * an expensive tier the developer didn't authorize for the task at hand, no matter how many
     * retries a validation/sandbox failure triggers. An instance override always wins over the
     * AI_MAX_PRIORITY env var (see getPriorityCeiling()).
     * @param {TaskPriority | null} priority - The highest allowed priority, or null to remove the cap.
     * @example
     * aiVendor.setPriorityCeiling('media-prioridad'); // never route to alta/muy-alta, even on retry
     */
    public setPriorityCeiling(priority: TaskPriority | null): void {
        this.priorityCeilingOverride = priority;
        this.logger.info(priority ? `[AI] Priority ceiling set to '${priority}'.` : '[AI] Priority ceiling cleared.');
    }

    /** Instance override (set via setPriorityCeiling) wins over the AI_MAX_PRIORITY env var, which
     *  in turn is the default ceiling for non-interactive commands with no UI to set one live. */
    private getPriorityCeiling(): TaskPriority | null {
        if (this.priorityCeilingOverride) return this.priorityCeilingOverride;
        const envCeiling = getEnvString('AI_MAX_PRIORITY') as TaskPriority | undefined;
        return envCeiling && TASK_PRIORITIES.includes(envCeiling) ? envCeiling : null;
    }

    /** Clamps `priority` down to the current ceiling (if any and if it's actually lower). No-op
     *  when no ceiling is configured, so this is fully backward compatible by default. */
    private clampPriority(priority: TaskPriority): TaskPriority {
        const ceiling = this.getPriorityCeiling();
        if (!ceiling) return priority;
        if (TASK_PRIORITIES.indexOf(priority) <= TASK_PRIORITIES.indexOf(ceiling)) return priority;
        this.logger.info(`[AI] Priority '${priority}' clamped down to ceiling '${ceiling}'.`);
        return ceiling;
    }

    /**
     * @method completeWithPriority
     * @description Convenience wrapper around complete() that resolves model + thinking effort
     * from a TaskPriority first. Equivalent to `complete(messages, resolvePriority(priority, options))`.
     * @param {AIMessage[]} messages - Conversation messages.
     * @param {TaskPriority} priority - Routing priority (see TaskPriority).
     * @param {AICompletionOptions} options - Optional overrides merged on top of the routed defaults.
     * @returns {Promise<AICompletionResult>}
     * @example
     * const result = await aiVendor.completeWithPriority(messages, 'alta-prioridad', { tools });
     */
    public async completeWithPriority(
        messages: AIMessage[],
        priority: TaskPriority,
        options: AICompletionOptions = {}
    ): Promise<AICompletionResult> {
        return this.complete(messages, this.resolvePriority(priority, options));
    }

    private splitSystem(messages: AIMessage[]): { system: string; turns: AIMessage[] } {
        const system = messages
            .filter(m => m.role === 'system')
            .map(m => (typeof m.content === 'string' ? m.content : m.content.map(b => (b.type === 'text' ? b.text : '')).join('')))
            .join('\n\n');
        const turns = messages.filter(m => m.role !== 'system');
        return { system, turns };
    }

    // --- Traducción de herramientas por vendor -------------------------------------------------

    private buildVendorTools(config: VendorConfig, tools?: AITool[]): any {
        if (!tools || tools.length === 0) return undefined;

        switch (config.vendor) {
            case 'anthropic':
                return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
            case 'openai':
                return tools.map(t => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.input_schema },
                }));
            case 'gemini':
                return [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
        }
    }

    // --- Traducción de mensajes por vendor ------------------------------------------------------

    private toAnthropicContent(content: string | AIContentBlock[]): any {
        if (typeof content === 'string') return content;
        return content.map(block => {
            if (block.type === 'text') return { type: 'text', text: block.text };
            if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
            if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
            return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, ...(block.is_error ? { is_error: true } : {}) };
        });
    }

    private buildAnthropicMessages(turns: AIMessage[]): any[] {
        return turns.map(m => ({ role: m.role, content: this.toAnthropicContent(m.content) }));
    }

    /**
     * OpenAI no tiene un bloque "tool_result" dentro de un mensaje de usuario: cada resultado de
     * herramienta tiene que ir en su propio mensaje con role: 'tool'. Por eso, a diferencia de
     * Anthropic, un único AIMessage de entrada puede expandirse a varios mensajes de salida.
     */
    private buildOpenAIMessages(turns: AIMessage[]): any[] {
        const result: any[] = [];

        for (const m of turns) {
            if (typeof m.content === 'string') {
                result.push({ role: m.role, content: m.content });
                continue;
            }

            if (m.role === 'assistant') {
                const text = m.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
                const toolUses = m.content.filter(b => b.type === 'tool_use') as Array<Extract<AIContentBlock, { type: 'tool_use' }>>;

                const msg: any = { role: 'assistant', content: text || null };
                if (toolUses.length > 0) {
                    msg.tool_calls = toolUses.map(t => ({
                        id: t.id,
                        type: 'function',
                        function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
                    }));
                }
                result.push(msg);
                continue;
            }

            const toolResults = m.content.filter(b => b.type === 'tool_result') as Array<Extract<AIContentBlock, { type: 'tool_result' }>>;
            const text = m.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
            const images = m.content.filter(b => b.type === 'image') as Array<Extract<AIContentBlock, { type: 'image' }>>;

            for (const tr of toolResults) {
                result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
            }
            if (images.length > 0) {
                const parts: any[] = [];
                if (text) parts.push({ type: 'text', text });
                for (const img of images) {
                    parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
                }
                result.push({ role: m.role, content: parts });
            } else if (text) {
                result.push({ role: m.role, content: text });
            }
        }

        return result;
    }

    /** Busca hacia atrás en TODO el historial (no solo en el turno actual) el nombre de la
     *  función asociada a un tool_use_id, porque Gemini necesita el `name` en el functionResponse
     *  y nosotros solo tenemos el id opaco que generamos al parsear la respuesta anterior. */
    private findToolUseName(allMessages: AIMessage[], toolUseId: string): string | undefined {
        for (const m of allMessages) {
            if (!Array.isArray(m.content)) continue;
            const match = m.content.find(b => b.type === 'tool_use' && b.id === toolUseId) as
                | Extract<AIContentBlock, { type: 'tool_use' }>
                | undefined;
            if (match) return match.name;
        }
        return undefined;
    }

    /**
     * NOTA: la API pública de Gemini espera los resultados de función en un content con
     * role: 'function' (parts: [{ functionResponse: { name, response } }]). Esto puede variar
     * entre versiones de la API — si Google cambia el contrato, este es el único sitio a tocar.
     */
    private buildGeminiContents(turns: AIMessage[], allMessages: AIMessage[]): any[] {
        const result: any[] = [];

        for (const m of turns) {
            if (typeof m.content === 'string') {
                result.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
                continue;
            }

            if (m.role === 'assistant') {
                const parts: any[] = [];
                for (const b of m.content) {
                    if (b.type === 'text' && b.text) parts.push({ text: b.text });
                    if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
                }
                result.push({ role: 'model', parts });
                continue;
            }

            const toolResults = m.content.filter(b => b.type === 'tool_result') as Array<Extract<AIContentBlock, { type: 'tool_result' }>>;
            const textBlocks = m.content.filter(b => b.type === 'text') as Array<Extract<AIContentBlock, { type: 'text' }>>;
            const imageBlocks = m.content.filter(b => b.type === 'image') as Array<Extract<AIContentBlock, { type: 'image' }>>;

            if (toolResults.length > 0) {
                result.push({
                    role: 'function',
                    parts: toolResults.map(tr => ({
                        functionResponse: {
                            name: this.findToolUseName(allMessages, tr.tool_use_id) ?? 'unknown_function',
                            response: { content: tr.content },
                        },
                    })),
                });
            }
            if (textBlocks.length > 0 || imageBlocks.length > 0) {
                result.push({
                    role: 'user',
                    parts: [
                        ...textBlocks.map(b => ({ text: b.text })),
                        ...imageBlocks.map(b => ({ inlineData: { mimeType: b.mediaType, data: b.data } })),
                    ],
                });
            }
        }

        return result;
    }

    /** Anthropic's extended thinking requires temperature === 1 and max_tokens strictly greater
     *  than budget_tokens; both are enforced here so callers never have to remember it. */
    private anthropicThinkingFields(config: VendorConfig): { thinking?: any; temperature: number; max_tokens: number } {
        const budget = resolveThinkingBudget(config.thinking, ANTHROPIC_THINKING_BUDGETS, ANTHROPIC_THINKING_BUDGET_ENV);
        if (!budget) return { temperature: config.temperature, max_tokens: config.maxTokens };

        return {
            thinking: { type: 'enabled', budget_tokens: budget },
            temperature: 1,
            max_tokens: Math.max(config.maxTokens, budget + 1024),
        };
    }

    /** True for OpenAI's reasoning-capable model families ('o' models: o1, o3... and the gpt-5
     *  line), which share two API quirks handled below: they reject the legacy `max_tokens` body
     *  field (Use `max_completion_tokens` instead — see buildRequest) and, when reasoning is on,
     *  reject a custom `temperature`. */
    private isOpenAIReasoningModel(model: string): boolean {
        return /^(o\d|gpt-5)/i.test(model);
    }

    /** OpenAI's `reasoning_effort` only exists on the 'o' reasoning model family and only accepts
     *  a fixed vocabulary (no 'none') — mapped from our vendor-agnostic ThinkingEffort via
     *  OPENAI_REASONING_EFFORTS/_ENV. Those models also reject a custom `temperature`, so it's
     *  omitted whenever reasoning_effort is set.
     *
     *  `reasoning_effort` combined with function `tools` on /v1/chat/completions is itself
     *  rejected with a 400 ("...are not supported... Please use /v1/responses instead") on at
     *  least the gpt-5 nano tier — so it's omitted whenever tools are present, trading explicit
     *  effort control for the request actually working; the model still reasons, just without an
     *  explicit tier hint. */
    private openaiReasoningFields(config: VendorConfig, hasTools: boolean): { reasoning_effort?: string; temperature?: number } {
        if (!this.isOpenAIReasoningModel(config.model) || config.thinking === 'none' || hasTools) {
            return { temperature: config.temperature };
        }

        return { reasoning_effort: resolveOpenAIReasoningEffort(config.thinking) };
    }

    /** Gemini 2.5+'s `thinkingConfig.thinkingBudget` is omitted entirely for 'none' rather than
     *  sent as 0, because 0 is invalid on Pro models (which can't fully disable thinking) — only
     *  Flash accepts it. Omitting the field is the safe "off" behavior across both. */
    private geminiThinkingFields(config: VendorConfig): { thinkingConfig?: { thinkingBudget: number } } {
        if (config.thinking === 'none') return {};
        const budget = resolveThinkingBudget(config.thinking, GEMINI_THINKING_BUDGETS, GEMINI_THINKING_BUDGET_ENV);
        return { thinkingConfig: { thinkingBudget: budget } };
    }

    private buildRequest(config: VendorConfig, messages: AIMessage[], stream: boolean, tools?: AITool[]): VendorRequest {
        const { system, turns } = this.splitSystem(messages);
        const vendorTools = this.buildVendorTools(config, tools);

        switch (config.vendor) {
            case 'anthropic': {
                const thinkingFields = this.anthropicThinkingFields(config);
                return {
                    url: 'https://api.anthropic.com/v1/messages',
                    headers: {
                        'x-api-key': config.apiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                    },
                    body: {
                        model: config.model,
                        system,
                        messages: this.buildAnthropicMessages(turns),
                        stream,
                        ...thinkingFields,
                        ...(vendorTools ? { tools: vendorTools } : {}),
                    },
                };
            }

            case 'openai': {
                const reasoningFields = this.openaiReasoningFields(config, !!vendorTools);
                // Reasoning-family models (o1/o3/gpt-5...) reject the legacy `max_tokens` field
                // with a 400 and require `max_completion_tokens` instead.
                const tokenField = this.isOpenAIReasoningModel(config.model)
                    ? { max_completion_tokens: config.maxTokens }
                    : { max_tokens: config.maxTokens };
                return {
                    url: 'https://api.openai.com/v1/chat/completions',
                    headers: {
                        Authorization: `Bearer ${config.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: {
                        model: config.model,
                        messages: [
                            ...(system ? [{ role: 'system', content: system }] : []),
                            ...this.buildOpenAIMessages(turns),
                        ],
                        ...tokenField,
                        stream,
                        ...reasoningFields,
                        ...(stream ? { stream_options: { include_usage: true } } : {}),
                        ...(vendorTools ? { tools: vendorTools } : {}),
                    },
                };
            }

            case 'gemini': {
                const action = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
                const thinkingFields = this.geminiThinkingFields(config);
                return {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:${action}key=${config.apiKey}`,
                    headers: { 'content-type': 'application/json' },
                    body: {
                        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
                        contents: this.buildGeminiContents(turns, messages),
                        generationConfig: {
                            temperature: config.temperature,
                            maxOutputTokens: config.maxTokens,
                            ...thinkingFields,
                        },
                        ...(vendorTools ? { tools: vendorTools } : {}),
                    },
                };
            }

            default:
                throw new TyrError(`Unsupported AI vendor: '${config.vendor}'`);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private isRetryable(status: number | undefined): boolean {
        return status === 429 || (status !== undefined && status >= 500);
    }

    private async withRetries<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (e: any) {
                lastError = e;
                const status = e?.response?.status;
                if (attempt === maxRetries || !this.isRetryable(status)) throw e;
                const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
                this.logger.warn(`AI request failed (status ${status ?? 'unknown'}). Retrying in ${delay}ms...`);
                await this.sleep(delay);
            }
        }
        throw lastError;
    }

    private parseCompletion(config: VendorConfig, data: any): AICompletionResult {
        switch (config.vendor) {
            case 'anthropic': {
                const blocks: AIContentBlock[] = (data.content ?? []).map((b: any) => {
                    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
                    return { type: 'text', text: b.text ?? '' };
                });
                return {
                    content: blocks.filter(b => b.type === 'text').map((b: any) => b.text).join(''),
                    blocks,
                    vendor: config.vendor,
                    model: config.model,
                    promptTokens: data.usage?.input_tokens,
                    completionTokens: data.usage?.output_tokens,
                    stopReason: data.stop_reason,
                };
            }

            case 'openai': {
                const message = data.choices?.[0]?.message ?? {};
                const blocks: AIContentBlock[] = [];

                if (message.content) blocks.push({ type: 'text', text: message.content });

                for (const call of message.tool_calls ?? []) {
                    let input: any = {};
                    try {
                        input = JSON.parse(call.function?.arguments || '{}');
                    } catch {
                        input = {};
                    }
                    blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
                }

                return {
                    content: message.content ?? '',
                    blocks,
                    vendor: config.vendor,
                    model: config.model,
                    promptTokens: data.usage?.prompt_tokens,
                    completionTokens: data.usage?.completion_tokens,
                    stopReason: data.choices?.[0]?.finish_reason,
                };
            }

            case 'gemini': {
                const parts = data.candidates?.[0]?.content?.parts ?? [];
                const blocks: AIContentBlock[] = [];
                let callIndex = 0;

                for (const p of parts) {
                    if (p.text) blocks.push({ type: 'text', text: p.text });
                    if (p.functionCall) {
                        // Gemini no da ids: generamos uno sintético que solo usamos internamente
                        // para poder emparejar el tool_result correspondiente más adelante.
                        blocks.push({
                            type: 'tool_use',
                            id: `gemini-call-${callIndex++}-${p.functionCall.name}`,
                            name: p.functionCall.name,
                            input: p.functionCall.args ?? {},
                        });
                    }
                }

                return {
                    content: blocks.filter(b => b.type === 'text').map((b: any) => b.text).join(''),
                    blocks,
                    vendor: config.vendor,
                    model: config.model,
                    promptTokens: data.usageMetadata?.promptTokenCount,
                    completionTokens: data.usageMetadata?.candidatesTokenCount,
                    stopReason: data.candidates?.[0]?.finishReason,
                };
            }
        }
    }

    /**
     * @method complete
     * @description Sends a chat-completion request and returns the full response once ready.
     * Retries automatically on rate limiting (429) or server errors (5xx). When `options.tools`
     * is provided, the model may respond with one or more `tool_use` blocks in `result.blocks`
     * instead of (or in addition to) text — the caller is responsible for executing those tools
     * and feeding the results back as a follow-up message with 'tool_result' blocks.
     * @param {AIMessage[]} messages - Conversation messages ('system', 'user', 'assistant').
     * @param {AICompletionOptions} options - Optional overrides (vendor, model, temperature, maxTokens, tools).
     * @returns {Promise<AICompletionResult>} The generated content plus vendor/model/usage metadata.
     * @example
     * const result = await ai.complete([{ role: 'user', content: 'Explain this bug...' }]);
     * console.log(result.content);
     * @example
     * // Tool use loop
     * let result = await ai.complete(messages, { tools });
     * while (result.blocks.some(b => b.type === 'tool_use')) {
     *   messages.push({ role: 'assistant', content: result.blocks });
     *   const toolResults = result.blocks
     *     .filter(b => b.type === 'tool_use')
     *     .map(b => ({ type: 'tool_result' as const, tool_use_id: b.id, content: runTool(b) }));
     *   messages.push({ role: 'user', content: toolResults });
     *   result = await ai.complete(messages, { tools });
     * }
     */
    public async complete(messages: AIMessage[], options?: AICompletionOptions): Promise<AICompletionResult> {
        const config = this.resolveConfig(options);
        this.logModelUsage(config);
        const { url, headers, body } = this.buildRequest(config, messages, false, options?.tools);

        try {
            const response = await this.withRetries(
                () => axios.post(url, body, { headers }),
                config.maxRetries
            );
            return this.parseCompletion(config, response.data);
        } catch (e: any) {
            if (e instanceof TyrError) throw e;
            const status = e?.response?.status;
            throw new TyrError(
                `AI request to '${config.vendor}' failed (${status ?? 'network error'})`,
                e,
                'Check your API key, network connection, and the vendor status page.'
            );
        }
    }

    /**
     * @method stream
     * @description Sends a chat-completion request and streams the response as it is generated.
     * Retries are only applied before any data has been received; once streaming has started,
     * failures are surfaced immediately to avoid emitting duplicated content.
     *
     * Tool use is NOT supported here: streaming tool calls arrive as incremental JSON fragments
     * (Anthropic's `input_json_delta`, OpenAI's indexed `tool_calls` deltas, Gemini's partial
     * function-call parts) and this method does not accumulate them. Passing `options.tools`
     * throws immediately rather than silently dropping tool calls the model might make mid-stream.
     * @param {AIMessage[]} messages - Conversation messages ('system', 'user', 'assistant').
     * @param {(chunk: string) => void} onChunk - Called with each incremental text fragment.
     * @param {AICompletionOptions} options - Optional overrides (vendor, model, temperature, maxTokens).
     * @returns {Promise<AICompletionResult>} The full accumulated content plus vendor/model/usage metadata.
     * @example
     * const result = await ai.stream(messages, (chunk) => process.stdout.write(chunk));
     */
    public async stream(
        messages: AIMessage[],
        onChunk: (chunk: string) => void,
        options?: AICompletionOptions
    ): Promise<AICompletionResult> {
        if (options?.tools && options.tools.length > 0) {
            throw new TyrError(
                'Tool use is not supported in streaming mode yet',
                null,
                'Use complete() instead of stream() when passing tools.'
            );
        }

        const config = this.resolveConfig(options);
        this.logModelUsage(config);
        const { url, headers, body } = this.buildRequest(config, messages, true);

        let content = '';
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let hasStreamedAny = false;

        const attemptStream = async (): Promise<void> => {
            const response = await axios.post(url, body, { headers, responseType: 'stream' });
            let buffer = '';

            for await (const chunk of response.data) {
                hasStreamedAny = true;
                buffer += chunk.toString('utf-8');

                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    const rawEvent = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);

                    for (const line of rawEvent.split('\n')) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;

                        const payload = trimmed.slice(5).trim();
                        if (payload === '[DONE]') continue;

                        let event: any;
                        try {
                            event = JSON.parse(payload);
                        } catch {
                            continue;
                        }

                        if (config.vendor === 'anthropic') {
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                content += event.delta.text;
                                onChunk(event.delta.text);
                            } else if (event.type === 'message_start') {
                                promptTokens = event.message?.usage?.input_tokens;
                            } else if (event.type === 'message_delta') {
                                completionTokens = event.usage?.output_tokens;
                            }
                        } else if (config.vendor === 'openai') {
                            const delta = event.choices?.[0]?.delta?.content;
                            if (delta) {
                                content += delta;
                                onChunk(delta);
                            }
                            if (event.usage) {
                                promptTokens = event.usage.prompt_tokens;
                                completionTokens = event.usage.completion_tokens;
                            }
                        } else if (config.vendor === 'gemini') {
                            const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) {
                                content += text;
                                onChunk(text);
                            }
                            if (event.usageMetadata) {
                                promptTokens = event.usageMetadata.promptTokenCount;
                                completionTokens = event.usageMetadata.candidatesTokenCount;
                            }
                        }
                    }
                }
            }
        };

        let attempt = 0;
        for (;;) {
            try {
                await attemptStream();
                break;
            } catch (e: any) {
                const status = e?.response?.status;
                if (hasStreamedAny || attempt >= config.maxRetries || !this.isRetryable(status)) {
                    throw new TyrError(
                        `AI streaming request to '${config.vendor}' failed (${status ?? 'network error'})`,
                        e,
                        'Check your API key, network connection, and the vendor status page.'
                    );
                }
                attempt++;
                const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
                this.logger.warn(`AI stream request failed (status ${status ?? 'unknown'}). Retrying in ${delay}ms...`);
                await this.sleep(delay);
            }
        }

        return { content, blocks: [{ type: 'text', text: content }], vendor: config.vendor, model: config.model, promptTokens, completionTokens };
    }
}

export const AIVendorManagerTests = {};