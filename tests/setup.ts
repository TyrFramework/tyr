import { vi } from 'vitest';
import { TyrContext } from '../src/core/Kernel.js';

export const createMockContext = (): TyrContext & Record<string, any> => ({
    frameworkRoot: '/mock/root',
    logger: {
        log:     vi.fn(),
        info:    vi.fn(),
        success: vi.fn(),
        error:   vi.fn(),
        warn:    vi.fn(),
    },
    shell: {
        cd:         vi.fn(),
        exec:       vi.fn().mockResolvedValue(''),
        input:      vi.fn().mockResolvedValue(''),
        showLoader: vi.fn(() => ({ stop: vi.fn() })),
    },
    fs: {
        exists:     vi.fn().mockReturnValue(true),
        read:       vi.fn().mockResolvedValue('# mock content'),
        write:      vi.fn().mockResolvedValue(undefined),
        createDir:  vi.fn().mockResolvedValue(undefined),
        delete:     vi.fn().mockResolvedValue(undefined),
        ensureLine: vi.fn().mockResolvedValue(undefined),
    },
    db: {
        searchBrokerOnDB: vi.fn().mockResolvedValue('mock-broker'),
        execute:          vi.fn().mockResolvedValue(undefined),
    },
    git: {
        clone:  vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        addAll: vi.fn().mockResolvedValue(undefined),
        init:   vi.fn().mockResolvedValue(undefined),
    },
    docker: {
        run:             vi.fn().mockResolvedValue(undefined),
        composeUp:       vi.fn().mockResolvedValue(undefined),
        containerExists: vi.fn().mockResolvedValue(false),
        isRunning:       vi.fn().mockResolvedValue(true),
    },
    web: {
        selectFromWeb: vi.fn().mockResolvedValue([]),
    },
    pkg: {
        install: vi.fn().mockResolvedValue(undefined),
        detect:  vi.fn().mockResolvedValue('apt'),
    },
    sys: {
        killPort:        vi.fn().mockResolvedValue(true),
        nukeNodeModules: vi.fn().mockResolvedValue(undefined),
    },
    task: vi.fn(async (_desc: string, action: () => any) => {
        return await action();
    }),
    run:  vi.fn().mockResolvedValue(undefined),
    fail: vi.fn((msg: string, suggestion?: string) => {
        const error = new Error(msg);
        (error as any).suggestion = suggestion;
        throw error;
    }),
});
