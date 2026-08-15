import { describe, expect, it } from 'vitest';
import { readLanguageTagInventory } from './panel';

describe('settings language inventory contract', () => {
    it('accepts a bounded sorted canonical regional inventory', () => {
        expect(readLanguageTagInventory({
            Languages: ['en-US', 'pt-BR'], Complete: true, Truncated: false,
        })).toEqual({ languages: ['en-US', 'pt-BR'], complete: true, truncated: false });
    });

    it.each([
        { Languages: ['pt-br'], Complete: true, Truncated: false },
        { Languages: ['pt-BR', 'pt-BR'], Complete: true, Truncated: false },
        { Languages: ['pt-BR', 'en-US'], Complete: true, Truncated: false },
        { Languages: Array.from({ length: 129 }, (_, index) => `q${String(index).padStart(3, '0')}`), Complete: false, Truncated: true },
        { Languages: ['en-US'], Complete: true, Truncated: true },
    ])('rejects malformed, unknown or oversized projections without using a subset', (value) => {
        expect(readLanguageTagInventory(value)).toBeNull();
    });
});
