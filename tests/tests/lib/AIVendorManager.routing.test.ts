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

    it('routes low to the cheap tier with no thinking', () => {
        const options = aiVendor.resolvePriority('low', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('none');
    });

    it('routes mid-low to the cheap tier with max thinking', () => {
        const options = aiVendor.resolvePriority('mid-low', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('high');
    });

    it('routes mid to the balanced tier with no thinking', () => {
        const options = aiVendor.resolvePriority('mid', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('none');
    });

    it('routes very-high to the flagship tier with max thinking', () => {
        const options = aiVendor.resolvePriority('very-high', { vendor: 'anthropic' });
        expect(options.model).toBe('claude-haiku-4-5-20251001');
        expect(options.thinking).toBe('max');
    });

    it('routes per-vendor when a different vendor is requested', () => {
        const options = aiVendor.resolvePriority('very-high', { vendor: 'openai' });
        expect(options.model).toBe('gpt-4o-mini-2024-07-18');
    });

    it('lets overrides win over the routed defaults', () => {
        const options = aiVendor.resolvePriority('low', { vendor: 'anthropic', model: 'custom-model', maxTokens: 500 });
        expect(options.model).toBe('custom-model');
        expect(options.maxTokens).toBe(500);
    });

    it('rejects an unknown priority', () => {
        expect(() => aiVendor.resolvePriority('not-a-real-priority' as any)).toThrow();
    });

    it('bumpPriority escalates one level at a time', () => {
        expect(aiVendor.bumpPriority('low')).toBe('mid-low');
        expect(aiVendor.bumpPriority('mid')).toBe('mid-high');
        expect(aiVendor.bumpPriority('high')).toBe('very-high');
    });

    it('bumpPriority caps at the top of the ladder', () => {
        expect(aiVendor.bumpPriority('very-high')).toBe('very-high');
    });
});

describe('AIVendorManager — priority ceiling', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('exports the ladder in order', () => {
        expect(TASK_PRIORITIES).toEqual([
            'low',
            'mid-low',
            'mid',
            'mid-high',
            'high',
            'very-high',
        ]);
    });

    it('clamps resolvePriority down to the ceiling', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('mid');

        const capped = aiVendor.resolvePriority('very-high', { vendor: 'anthropic' });
        const uncapped = aiVendor.resolvePriority('mid', { vendor: 'anthropic' });
        expect(capped.thinking).toBe(uncapped.thinking);
        expect(capped.model).toBe(uncapped.model);
    });

    it('does not clamp a priority already at or below the ceiling', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('high');

        const options = aiVendor.resolvePriority('low', { vendor: 'anthropic' });
        const uncapped = new AIVendorManager(mockLogger).resolvePriority('low', { vendor: 'anthropic' });
        expect(options).toEqual(uncapped);
    });

    it('bumpPriority never escalates past the ceiling, even called repeatedly', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('mid-high');

        let priority = aiVendor.bumpPriority('low');
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        priority = aiVendor.bumpPriority(priority);
        expect(priority).toBe('mid-high');
    });

    it('setPriorityCeiling(null) clears the cap', () => {
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('low');
        aiVendor.setPriorityCeiling(null);

        expect(aiVendor.bumpPriority('mid')).toBe('mid-high');
    });

    it('respects AI_MAX_PRIORITY as a default ceiling when no instance override is set', () => {
        vi.stubEnv('AI_MAX_PRIORITY', 'mid-low');
        const aiVendor = new AIVendorManager(mockLogger);

        expect(aiVendor.bumpPriority('low')).toBe('mid-low');
        expect(aiVendor.bumpPriority('mid-low')).toBe('mid-low');
    });

    it('an instance override wins over the AI_MAX_PRIORITY env var', () => {
        vi.stubEnv('AI_MAX_PRIORITY', 'very-high');
        const aiVendor = new AIVendorManager(mockLogger);
        aiVendor.setPriorityCeiling('low');

        expect(aiVendor.bumpPriority('low')).toBe('low');
    });
});
