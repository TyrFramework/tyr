import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TyrError } from '../../../src/core/TyrError.js';
import { Logger } from '../../../src/core/Logger.js';

const createMockLogger = (): Logger => ({
    log: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
});

describe('TyrError', () => {
    describe('constructor', () => {
        it('should store all provided fields', () => {
            const cause = new Error('original');
            const err = new TyrError('Something failed', cause, 'Try again', 'install');

            expect(err.message).toBe('Something failed');
            expect(err.originalError).toBe(cause);
            expect(err.suggestion).toBe('Try again');
            expect(err.commandName).toBe('install');
            expect(err.isTyrError).toBe(true);
        });

        it('should extend Error', () => {
            const err = new TyrError('fail');
            expect(err).toBeInstanceOf(Error);
        });

        it('should work with only a message', () => {
            const err = new TyrError('minimal');
            expect(err.message).toBe('minimal');
            expect(err.originalError).toBeUndefined();
            expect(err.suggestion).toBeUndefined();
            expect(err.commandName).toBeUndefined();
        });
    });

    describe('handle()', () => {
        let logger: Logger;

        beforeEach(() => {
            logger = createMockLogger();
        });

        it('should call logger.error with the message', () => {
            const err = new TyrError('Something went wrong');
            err.handle(false, logger);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
        });

        it('should include commandName in the output when provided', () => {
            const err = new TyrError('fail', null, undefined, 'deploy');
            err.handle(false, logger);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('deploy'));
        });

        it('should not mention commandName when not provided', () => {
            const err = new TyrError('fail');
            err.handle(false, logger);
            const allCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
            expect(allCalls).not.toContain('Error in command');
        });

        it('should show caused-by when originalError is an Error', () => {
            const cause = new Error('disk full');
            const err = new TyrError('Write failed', cause);
            err.handle(true, logger);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        });

        it('should show caused-by when originalError is a string', () => {
            const err = new TyrError('Write failed', 'permission denied');
            err.handle(true, logger);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
        });

        it('should not show caused-by when isDebug is false', () => {
            const err = new TyrError('Write failed', 'permission denied');
            err.handle(false, logger);
            const allCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
            expect(allCalls).not.toContain('permission denied');
        });

        it('should call logger.warn with suggestion when provided', () => {
            const err = new TyrError('fail', null, 'Check your config');
            err.handle(false, logger);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Check your config'));
        });

        it('should not call logger.warn when no suggestion', () => {
            const err = new TyrError('fail');
            err.handle(false, logger);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should show stack trace in debug mode', () => {
            const cause = new Error('cause');
            const err = new TyrError('fail', cause);
            err.handle(true, logger);
            expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Stack Trace'));
        });

        it('should show --debug hint in user mode', () => {
            const err = new TyrError('fail');
            err.handle(false, logger);
            expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('--debug'));
        });
    });
});
