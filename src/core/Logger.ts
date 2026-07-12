/**
 * @fileoverview The framework's standardised output surface. `Container.init()` constructs a
 * single `Logger` (via `createLogger()`) and exposes it on every {@link TyrContext} as
 * `context.logger`. Commands should always log through this instead of `console.log` directly, so
 * output is consistently colour-coded and mirrored to `~/.tyr/logs/<date>.log` for later
 * debugging. `TyrError.handle()` also uses a `Logger` to print formatted error output.
 */
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

/** The logging surface every Tyr command and Manager uses instead of `console.*` directly. */
export interface Logger {
    /** Prints a separator/section line. With no `opts`, prints a blank line. */
    line(opts: any): void;
    /** Plain, uncoloured log line (also written to the log file). */
    log(msg: any): void;
    /** Informational message, prefixed with a blue "ℹ" icon. */
    info(msg: any): void;
    /** Positive/completion message, prefixed with a green "✔" icon. */
    success(msg: any): void;
    /** Error message, prefixed with a red "✖" icon (printed to stderr). */
    error(msg: any): void;
    /** Warning message, prefixed with a yellow "⚠" icon (printed to stderr). */
    warn(msg: any): void;
}

/**
 * Builds a {@link Logger} that writes to the console (colourised via chalk) and appends a plain
 * copy of every call to `~/.tyr/logs/<YYYY-MM-DD>.log`, so a failure can be diagnosed after the
 * fact even without `--debug`. File-write failures are swallowed on purpose (see `writeToFile`)
 * so a logging problem (e.g. a read-only `~/.tyr`) never itself crashes the command being logged.
 * @param {boolean} isDebug - Reserved for future use (verbosity is currently controlled by the
 *   caller checking `isDebug` itself, e.g. in `TyrError.handle()`); accepted here so the Container
 *   only needs to know about `isDebug` in one place.
 * @returns {Logger} A ready-to-use logger instance.
 * @example
 * const logger = createLogger(false);
 * logger.success('Done.');
 */
export function createLogger(isDebug: boolean): Logger {
    const logDir = path.join(homedir(), '.tyr', 'logs');
    const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

    const writeToFile = (level: string, msg: any) => {
        try {
            fs.mkdirSync(logDir, { recursive: true });
            const timestamp = new Date().toISOString();
            const line = `[${timestamp}] [${level}] ${String(msg)}\n`;
            fs.appendFileSync(logFile, line, 'utf-8');
        } catch {
            // Logging failures must never crash the application
        }
    };

    return {
        line: (opts) => {
            if (opts) {
                let {char, title, count} = opts;
                if (!count) count = 45;
                let content = '';
                if (title) content = `${char} ${title} ${char}`;
                else {
                    for (let i = 0; i < count; i++) content += char;
                }
                console.log(content);
            } else {
                console.log('');
            }
        },
        log: (msg) => {
            console.log(msg);
            writeToFile('LOG', msg);
        },
        info: (msg) => {
            console.log(chalk.blue('ℹ'), msg);
            writeToFile('INFO', msg);
        },
        success: (msg) => {
            console.log(chalk.green('✔'), msg);
            writeToFile('SUCCESS', msg);
        },
        error: (msg) => {
            console.error(chalk.red('✖'), msg);
            writeToFile('ERROR', msg);
        },
        warn: (msg) => {
            console.warn(chalk.yellow('⚠'), msg);
            writeToFile('WARN', msg);
        },
    };
}
