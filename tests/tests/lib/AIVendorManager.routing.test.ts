import { describe, it, expect, afterEach, vi } from 'vitest';
import { AIVendorManager, TASK_PRIORITIES } from '../../../src/lib/AIVendorManager.js';
import { Logger } from '../../../src/core/Logger.js';

const mockLogger: Logger = {
    line: () => {},
    log: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
    warn: () => {},
};

describe('AIVendorManager — Dynamic Model Routing', () => {
    const aiVendor = new AIVendorManager(mockLogger);

    it('routes baja-prioridad to the cheap tier with no thinking', () => {
        const options = aiVendor.resolvePriority('baja-prioridad', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('none');
    });

    it('routes baja-media-prioridad to the cheap tier with max thinking', () => {
        const options = aiVendor.resolvePriority('baja-media-prioridad', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('high');
    });

    it('routes media-prioridad to the balanced tier with no thinking', () => {
        const options = aiVendor.resolvePriority('media-prioridad', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('none');
    });

    it('routes muy-alta-prioridad to the flagship tier with max thinking', () => {
        const options = aiVendor.resolvePriority('muy-alta-prioridad', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('max');
    });

    it('routes per-vendor when a different vendor is requested', () => {
        const options = aiVendor.resolvePriority('muy-alta-prioridad', { vendor: 'openai' });
        expect(options.model).toBe('gpt-4o-mini-2024-07-18');
    });

    it('lets overrides win over the routed defaults', () => {
        const options = aiVendor.resolvePriority('baja-prioridad', { vendor: 'anthropic', model: 'custom-model', maxTokens: 500 });
        expect(options.model).toBe('custom-model');
        expect(options.maxTokens).toBe(500);
    });

    it('rejects an unknown priority', () => {
        expect(() => aiVendor.resolvePriority('not-a-real-priority' as any)).toThrow();
    });

    it('bumpPriority escalates one level at a time', () => {
        expect(aiVendor.bumpPriority('baja-prioridad')).toBe('baja-media-prioridad');
        expect(aiVendor.bumpPriority('media-prioridad')).toBe('media-alta-prioridad');
        expect(aiVendor.bumpPriority('alta-prioridad')).toBe('muy-alta-prioridad');
    });

    it('bumpPriority caps at the top of the ladder', () => {
        expect(aiVendor.bumpPriority('muy-alta-prioridad')).toBe('muy-alta-prioridad');
    });
});

describe('AIVendorManager — priority ceiling', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('exports the ladder in order', () => {
        expect(TASK_PRIORITIES).toEqual([
            'baja-prioridad',
            'baja-media-prioridad',
            'media-prioridad',
            'media-alta-prioridad',
            'alta-prioridad',
            'muy-alta-prioridad',
        ]);
    });

    it('clamps resolvePriority down to the ceiling', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('media-prioridad');

        const capped = aiVendor.resolvePriority('muy-alta-prioridad', { vendor: 'anthropic' });
        const uncapped = aiVendor.resolvePriority('media-prioridad', { vendor: 'anthropic' });
        expect(capped.thinking).toBe(uncapped.thinking);
        expect(capped.model).toBe(uncapped.model);
    });

    it('does not clamp a priority already at or below the ceiling', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('alta-prioridad');

        const options = aiVendor.resolvePriority('baja-prioridad', { vendor: 'anthropic' });
        const uncapped = new AIVendorManager(mockLogger).resolvePriority('baja-prioridad', { vendor: 'anthropic' });
        expect(options).toEqual(uncapped);
    });

    it('bumpPriority never escalates past the ceiling, even called repeatedly', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('media-alta-prioridad');

        let priority = aiVendor.bumpPriority('baja-prioridad');
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        expect(priority).toBe('media-alta-prioridad');
    });

    it('setPriorityCeiling(null) clears the cap', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('baja-prioridad');
        aiVendor.setPriorityCeiling(null);

        expect(aiVendor.bumpPriority('media-prioridad')).toBe('media-alta-prioridad');
    });

    it('respects AI_MAX_PRIORITY as a default ceiling when no instance override is set', () => {
        vi.stubEnv('AI_MAX_PRIORITY', 'baja-media-prioridad');
        const aiVendor = new AIVendorManager(mockLogger);

        expect(aiVendor.bumpPriority('baja-prioridad')).toBe('baja-media-prioridad');
        expect(aiVendor.bumpPriority('baja-media-prioridad')).toBe('baja-media-prioridad');
    });

    it('an instance override wins over the AI_MAX_PRIORITY env var', () => {
        vi.stubEnv('AI_MAX_PRIORITY', 'muy-alta-prioridad');
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('baja-prioridad');

        expect(aiVendor.bumpPriority('baja-prioridad')).toBe('baja-prioridad');
    });
});
