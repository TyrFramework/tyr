/**
 * @fileoverview Tyr's structured error type. This is the currency the rest of the framework deals
 * in: `TyrContext.fail()` throws one directly, `TyrContext.task()` wraps any thrown error in one
 * to attach a human-readable description, and `Kernel.handleError()` normalises whatever a command
 * throws into one before printing it. Keeping a single error shape lets the Kernel format every
 * failure the same way (message, optional suggestion, optional stack trace) regardless of where
 * in the command it originated.
 */
import { Logger, createLogger } from './Logger.js';

/**
 * @class TyrError
 * @description A controlled, formattable error carrying an optional cause (`originalError`), an
 * optional actionable hint (`suggestion`) and the command it happened in (`commandName`, usually
 * filled in later by `Kernel.handleError()` rather than at throw time).
 */
export class TyrError extends Error {
    public readonly originalError: unknown;
    /** Cheap runtime type tag (no `instanceof` needed across module boundaries) — not currently
     *  read anywhere in this codebase but kept as part of the public shape for consumers. */
    public readonly isTyrError = true;
    public readonly suggestion?: string;
    public readonly commandName?: string;

    /**
     * @param {string} message - Human-readable description of what went wrong.
     * @param {unknown} originalError - The underlying error/value that caused this, if any.
     * @param {string} suggestion - Optional actionable hint shown to the user (e.g. a command to run).
     * @param {string} commandName - Name of the command that was running when this was thrown.
     * @example
     * throw new TyrError('Config file not found', e, 'Run "tyr --config" first.');
     */
    constructor(message: string, originalError?: unknown, suggestion?: string, commandName?: string) {
        super(message);
        this.originalError = originalError;
        this.suggestion = suggestion;
        this.commandName = commandName;
        Error.captureStackTrace(this, this.constructor);
    }

    /** Best-effort stringification of `originalError` for display: unwraps a real `Error`'s
     *  message, passes strings through, and falls back to JSON (or a fixed placeholder if even
     *  that fails, e.g. for a value with circular references). */
    private extractErrorMessage(err: unknown): string {
        if (err instanceof Error) return err.message;
        if (typeof err === 'string') return err;
        try {
            return JSON.stringify(err);
        } catch {
            return 'Unknown error (non-serializable)';
        }
    }

    /**
     * @method handle
     * @description Prints this error to the console in the framework's standard format (command
     * name, message, optional suggestion) and exits — actually calling `process.exit(1)` is the
     * caller's job (see `Kernel.handleError()`); this method only prints. The stack trace (this
     * error's own, or the underlying cause's if there is one) is only shown when `isDebug` is true,
     * to keep normal output short while still being fully diagnosable with `--debug`.
     * @param {boolean} isDebug - Whether to print the "Caused by" detail and full stack trace.
     * @param {Logger} _logger - Logger to print through; a fresh one is created if omitted.
     * @example
     * try { ... } catch (e) { new TyrError('Failed', e).handle(true); }
     */
    public handle(isDebug: boolean = false, _logger?: Logger): void {
        const logger = _logger ?? createLogger(isDebug);

        if (this.commandName) {
            logger.error(`Error in command: ${this.commandName}`);
        }

        logger.error('Oops! An error occurred.');
        logger.error(`↳  ${this.message}`);

        if (this.originalError && isDebug) {
            logger.error(`      ↳ Caused by: ${this.extractErrorMessage(this.originalError)}`);
        }

        if (this.suggestion) {
            logger.warn(`   Suggestion: ${this.suggestion}`);
        }

        if (isDebug) {
            if (this.originalError instanceof Error) {
                logger.log('\n--- Stack Trace ---');
                logger.log(this.originalError.stack);
            } else {
                logger.log('\n--- Stack Trace ---');
                logger.log(this);
            }
        } else {
            logger.log('\n(Use --debug to see the full stack trace)');
        }
    }
}
