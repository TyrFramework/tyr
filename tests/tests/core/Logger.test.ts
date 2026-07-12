import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { createLogger } from '../../../src/core/Logger.js';

describe('Logger', () => {
    let mkdirSpy: ReturnType<typeof vi.spyOn>;
    let appendSpy: ReturnType<typeof vi.spyOn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mkdirSpy       = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
        appendSpy      = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined);
        consoleLogSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy= vi.spyOn(console, 'error').mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createLogger()', () => {
        it('should create the log directory on first write', () => {
            const logger = createLogger(false);
            logger.log('trigger write');
            expect(mkdirSpy).toHaveBeenCalled();
        });

        it('log() should print to console and write to file', () => {
            const logger = createLogger(false);
            logger.log('hello');
            expect(consoleLogSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[LOG]'),
                'utf-8'
            );
        });

        it('info() should print to console and write to file', () => {
            const logger = createLogger(false);
            logger.info('some info');
            expect(consoleLogSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[INFO]'),
                'utf-8'
            );
        });

        it('success() should print to console and write to file', () => {
            const logger = createLogger(false);
            logger.success('done');
            expect(consoleLogSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[SUCCESS]'),
                'utf-8'
            );
        });

        it('error() in user mode should print to console and write to file', () => {
            const logger = createLogger(false);
            logger.error('something broke');
            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[ERROR]'),
                'utf-8'
            );
        });

        it('error() in debug mode should print to console and write to file', () => {
            const logger = createLogger(true);
            logger.error('something broke');
            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[ERROR]'),
                'utf-8'
            );
        });

        it('warn() in user mode should print to console and write to file', () => {
            const logger = createLogger(false);
            logger.warn('careful');
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[WARN]'),
                'utf-8'
            );
        });

        it('warn() in debug mode should print to console and write to file', () => {
            const logger = createLogger(true);
            logger.warn('careful');
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(appendSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('[WARN]'),
                'utf-8'
            );
        });

        it('log entries should include a timestamp', () => {
            const logger = createLogger(false);
            logger.info('timestamped');
            const written = appendSpy.mock.calls[0][1] as string;
            expect(written).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
        });
    });
});
