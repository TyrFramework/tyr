/**
 * @fileoverview Built-in `tyr chat [directory]` command. Thin wiring layer over two independent
 * Managers: {@link ChatManager} (owns the local web server, session state and file browser — knows
 * nothing about AI) and {@link AIVendorManager} (owns talking to the configured AI vendor — knows
 * nothing about chat sessions). This file's only job is to register a `chatManager.onMessage()`
 * handler that bridges the two: turn a `ChatMessageContext` into an `AIMessage[]` prompt, route it
 * through `aiVendor.completeWithPriority()`, and return the reply text. A custom command wanting
 * different chat behaviour (a different vendor, tool use, a canned responder) can copy this file
 * and only change the body of `onMessage()` — see the "customise it" example in README.md.
 */
import path from 'path';
import { readFile } from 'fs/promises';
import { TyrContext } from '../Kernel';
import type { AIContentBlock, AIMessage, TaskPriority } from '../../lib/AIVendorManager';
import type { ChatMessageContext } from '../../lib/ChatManager';

/** Reads `--flagName value` out of an argv-style array; returns `undefined` if the flag is absent
 *  or has nothing after it. Used for `--port`, `--split`, `--priority` and `--max-priority` below. */
function parseFlag(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    return index !== -1 ? args[index + 1] : undefined;
}

/**
 * @method chat (default export)
 * @description Opens a `ChatManager` session for `directory` and wires its `onMessage` hook to
 * `AIVendorManager`, routed by `TaskPriority` (see chat.ts's inline comments on `priority` and
 * `maxPriority` below for the reasoning behind the defaults). Also wires two example event
 * listeners (`message:send`, `message:error`) purely for logging.
 * @param {TyrContext} context - Uses `logger`, `chat` (ChatManager), `aiVendor` (AIVendorManager), `fail`.
 * @returns {(args: string[]) => Promise<void>} Handler expecting
 *   `args = [directory?, --port n?, --split 0-1?, --priority p?, --max-priority p?]`.
 * @example
 * // tyr chat ./my-project --split 0.35
 */
export default function chat({ logger, chat: chatManager, aiVendor, fail }: TyrContext) {
    return async (args: string[]) => {
        const positional = args.filter((a) => !a.startsWith('--'));
        const dir = path.resolve(positional[0] ?? process.cwd());

        const portArg = parseFlag(args, '--port');
        const splitArg = parseFlag(args, '--split');
        const port = portArg ? parseInt(portArg, 10) : undefined;
        const splitRatio = splitArg ? parseFloat(splitArg) : undefined;

        // Which routing priority (model tier + thinking effort) answers a chat message with —
        // see AIVendorManager.TaskPriority. Chat defaults to 'mid' (the same default
        // ai:code uses) rather than something cheaper, since a wrong answer in an interactive
        // back-and-forth is more disruptive than in a one-shot batch command.
        const priority = (parseFlag(args, '--priority') as TaskPriority | undefined) ?? 'mid';

        // Complexity/cost ceiling ("techo de complejidad"): no resolved priority may ever exceed
        // this, no matter what --priority above (or a future per-message override) asks for. Falls
        // back to AI_CHAT_MAX_PRIORITY so a chat session can be capped independently from ai:code /
        // ai:describe (which fall back to the general AI_MAX_PRIORITY instead — see
        // AIVendorManager.getPriorityCeiling()). --max-priority overrides both for this one run.
        const maxPriority = (parseFlag(args, '--max-priority') as TaskPriority | undefined)
            ?? (process.env.AI_CHAT_MAX_PRIORITY as TaskPriority | undefined);
        if (maxPriority) aiVendor.setPriorityCeiling(maxPriority);

        // Default responder: forwards the conversation (plus any attached images) to the
        // configured AI vendor, routed through the same priority/ceiling system as ai:code and
        // ai:describe. Replace with your own chatManager.onMessage(...) in a custom command if you
        // want different behaviour.
        chatManager.onMessage(async ({ message, history, dir: chatDir }: ChatMessageContext) => {
            const priorTurns: AIMessage[] = history.slice(0, -1).map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.text,
            }));

            const contentBlocks: AIContentBlock[] = [];
            if (message.text) contentBlocks.push({ type: 'text', text: message.text });

            for (const attachment of message.attachments) {
                try {
                    const fileBuffer = await readFile(attachment.path);
                    contentBlocks.push({ type: 'image', mediaType: attachment.mimeType, data: fileBuffer.toString('base64') });
                } catch (e) {
                    logger.warn(`Could not read attachment '${attachment.filename}': ${(e as Error).message}`);
                }
            }

            const messages: AIMessage[] = [
                {
                    role: 'system',
                    content: `You are an assistant embedded in a chat UI browsing the directory: ${chatDir}. Answer helpfully and concisely, referencing its files when relevant.`,
                },
                ...priorTurns,
                { role: 'user', content: contentBlocks.length > 0 ? contentBlocks : message.text },
            ];

            const result = await aiVendor.completeWithPriority(messages, priority);
            return result.content;
        });

        // Example hooks — side effects around the conversation, independent from onMessage.
        chatManager.on('message:send', ({ message }: { message: { text: string } }) => {
            logger.info(`[chat] user: ${message.text}`);
        });
        chatManager.on('message:error', ({ error }: { error: Error }) => {
            logger.warn(`[chat] handler failed: ${error.message}`);
        });

        try {
            const session = await chatManager.open(dir, { port, splitRatio });
            logger.success(`Chat ready at: ${session.url}`);
            logger.info(`Browsing: ${session.dir}`);
            logger.info(`Priority: ${priority}${maxPriority ? ` (ceiling: ${maxPriority})` : ''}`);
            logger.info('Press Ctrl+C to stop.');
        } catch (e: any) {
            fail(`Could not start chat: ${e.message}`, 'Check that the directory exists and the port is free.');
        }
    };
}
