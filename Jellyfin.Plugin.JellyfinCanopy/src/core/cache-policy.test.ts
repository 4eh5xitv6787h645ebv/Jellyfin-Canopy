import { describe, expect, it } from 'vitest';
import {
    classifyArrayPayload,
    classifyObjectDetails,
    classifyResultsEnvelope,
} from './cache-policy';

describe('semantic response cache policy', () => {
    it('classifies only explicit object absence as negative', () => {
        expect(classifyObjectDetails(null)).toBe('negative');
        expect(classifyObjectDetails({ id: 1 })).toBe('positive');
        expect(classifyObjectDetails(undefined)).toBe('skip');
        expect(classifyObjectDetails([])).toBe('skip');
    });

    it('requires a valid results envelope before caching search absence', () => {
        expect(classifyResultsEnvelope({ results: [] })).toBe('negative');
        expect(classifyResultsEnvelope({ results: [{ id: 1 }] })).toBe('positive');
        expect(classifyResultsEnvelope({})).toBe('skip');
        expect(classifyResultsEnvelope(null)).toBe('skip');
    });

    it('treats only a valid empty list as authoritative list absence', () => {
        expect(classifyArrayPayload([])).toBe('negative');
        expect(classifyArrayPayload([{ id: 1 }])).toBe('positive');
        expect(classifyArrayPayload({ results: [] })).toBe('skip');
    });
});
