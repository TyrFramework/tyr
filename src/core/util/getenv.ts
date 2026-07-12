/**
 * @fileoverview Typed, fallback-aware accessors for environment variables. Used throughout
 * `src/lib/*.ts` (Managers) and `src/core/sys/*.ts` (built-in commands) instead of reading
 * `process.env` directly, so a missing/empty var consistently falls back rather than producing
 * `undefined` or the literal string `"undefined"` deep in some other computation. Each function
 * is overloaded so that passing a fallback narrows the return type to non-optional — callers that
 * supply a default never need an extra null-check.
 */

/**
 * Reads a string environment variable, treating an unset OR empty-string value the same way (both
 * fall back) — this matters for `.env` files, where `FOO=` and a missing `FOO` line are easy to
 * confuse and should behave identically.
 * @param {string} name - Environment variable name.
 * @param {string} [fallback] - Value to return if unset or empty.
 * @returns {string | undefined} The variable's value, or `fallback`.
 * @example
 * const vendor = getEnvString('AI_VENDOR', 'anthropic');
 */
export function getEnvString(name: string, fallback: string): string;
export function getEnvString(name: string, fallback?: string): string | undefined;
export function getEnvString(name: string, fallback?: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}


/**
 * Reads an integer environment variable. Falls back on an unset/empty value, and also on a value
 * that fails to parse as a valid integer (`NaN`), so a typo'd `.env` entry degrades to the default
 * instead of poisoning downstream arithmetic with `NaN`.
 * @param {string} name - Environment variable name.
 * @param {number} [fallback] - Value to return if unset, empty, or not a valid integer.
 * @returns {number | undefined} The parsed integer, or `fallback`.
 * @example
 * const maxTokens = getEnvInt('AI_MAX_TOKENS', 4096);
 */
export function getEnvInt(name: string, fallback: number): number;
export function getEnvInt(name: string, fallback?: number): number | undefined;
export function getEnvInt(name: string, fallback?: number): number | undefined {
    const raw = getEnvString(name);
    if (raw === undefined) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) ? fallback : value;
}


/**
 * Reads a floating-point environment variable. Same unset/empty/unparseable fallback behaviour
 * as {@link getEnvInt}, using `parseFloat` instead of `parseInt`.
 * @param {string} name - Environment variable name.
 * @param {number} [fallback] - Value to return if unset, empty, or not a valid number.
 * @returns {number | undefined} The parsed number, or `fallback`.
 * @example
 * const temperature = getEnvDouble('AI_TEMPERATURE', 0.3);
 */
export function getEnvDouble(name: string, fallback: number): number;
export function getEnvDouble(name: string, fallback?: number): number | undefined;
export function getEnvDouble(name: string, fallback?: number): number | undefined {
    const raw = getEnvString(name);
    if (raw === undefined) return fallback;
    const value = Number.parseFloat(raw);
    return Number.isNaN(value) ? fallback : value;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);


/**
 * Reads a boolean environment variable from a small fixed vocabulary (`1/true/yes/on` vs.
 * `0/false/no/off`, case-insensitive). Anything outside that vocabulary — including unset, empty,
 * or an unrecognised string — falls back, rather than being coerced by JS truthiness (which would
 * treat the string `"false"` as truthy).
 * @param {string} name - Environment variable name.
 * @param {boolean} [fallback] - Value to return if unset, empty, or not a recognised boolean word.
 * @returns {boolean | undefined} The parsed boolean, or `fallback`.
 * @example
 * const debug = getEnvBool('TYR_DEBUG', false);
 */
export function getEnvBool(name: string, fallback: boolean): boolean;
export function getEnvBool(name: string, fallback?: boolean): boolean | undefined;
export function getEnvBool(name: string, fallback?: boolean): boolean | undefined {
    const raw = getEnvString(name);
    if (raw === undefined) return fallback;

    const normalized = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return fallback;
}

/**
 * Reads a delimited-list environment variable (default separator: comma), trimming whitespace
 * around each entry and dropping empty entries (so `"a, ,b"` becomes `['a', 'b']`, not
 * `['a', '', 'b']`). Falls back on unset/empty input or when every entry turns out empty after
 * trimming.
 * @param {string} name - Environment variable name.
 * @param {string[]} [fallback] - Value to return if unset, empty, or has no non-empty entries.
 * @param {string} [separator] - Delimiter between entries (default: `','`).
 * @returns {string[] | undefined} The parsed array, or `fallback`.
 * @example
 * const dirs = getEnvArray('IGNORED_DIRS', ['node_modules', '.git']);
 */
export function getEnvArray(name: string, fallback: string[], separator?: string): string[];
export function getEnvArray(name: string, fallback?: string[], separator?: string): string[] | undefined;
export function getEnvArray(name: string, fallback?: string[], separator: string = ','): string[] | undefined {
    const raw = getEnvString(name);
    if (raw === undefined) return fallback;

    const values = raw
        .split(separator)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return values.length > 0 ? values : fallback;
}
