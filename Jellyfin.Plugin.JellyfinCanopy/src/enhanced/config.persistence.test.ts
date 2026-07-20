import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { IdentityContext } from '../types/jc';
import { UserSettingsPersistenceError } from './config';

const HASH = 'a'.repeat(64);

function startSession(): IdentityContext {
    JC.identity.transition('', '', 'persistence-test-logout');
    return JC.identity.transition('test-server-id', 'test-user-id', 'persistence-test-login')!;
}

function own<T extends Record<string, unknown>>(value: T): T {
    return JC.identity.own(value, JC.identity.capture());
}

function acknowledged(file: string, revision: number, data: Record<string, unknown>) {
    return { success: true, file, revision, contentHash: HASH, data: { ...data, Revision: revision } };
}

function httpError(status: number, responseJSON?: Record<string, unknown>) {
    return Object.assign(new Error(`HTTP ${status}`), { status, responseJSON });
}

describe('acknowledged user-settings persistence', () => {
    beforeEach(() => {
        startSession();
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('requires a matching acknowledgement before advancing deduplication', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'new';
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValueOnce(acknowledged('settings.json', 1, { Mode: 'new' }));

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'unavailable', status: 503, retryable: true
        });
        expect(settings).toEqual({ Revision: 0, Mode: 'old' });

        settings.Mode = 'new';
        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({
            acknowledged: true, deduplicated: false, revision: 1
        });
        expect(ajax).toHaveBeenCalledTimes(2);

        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({
            acknowledged: true, deduplicated: true, revision: 1, contentHash: HASH
        });
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('does not treat a loaded baseline as write acknowledgement evidence', async () => {
        const settings = own({ Revision: 7, Mode: 'same' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        expect(JC.getAcknowledgedUserSettingsSnapshot!('settings.json')).toBeNull();
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValue(acknowledged('settings.json', 7, { Mode: 'same' }));

        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({
            acknowledged: true, deduplicated: false, revision: 7, contentHash: HASH
        });
        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({
            acknowledged: true, deduplicated: true, revision: 7, contentHash: HASH
        });
        expect(ajax).toHaveBeenCalledTimes(1);
        const first = JC.getAcknowledgedUserSettingsSnapshot!('settings.json') as Record<string, unknown>;
        expect(first).toEqual({ Revision: 7, Mode: 'same' });
        expect(JC.identity.isOwned(first, JC.identity.capture())).toBe(true);
        first.Mode = 'mutated copy';
        expect(JC.getAcknowledgedUserSettingsSnapshot!('settings.json'))
            .toEqual({ Revision: 7, Mode: 'same' });

        JC.identity.transition('test-server-id', 'other-user-id', 'persistence-test-switch');
        expect(JC.getAcknowledgedUserSettingsSnapshot!('settings.json')).toBeNull();
    });

    it('accepts the PascalCase acknowledgement envelope emitted by the live ASP.NET host', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'new';
        vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            Success: true,
            Conflict: false,
            File: 'settings.json',
            Revision: 1,
            ContentHash: HASH,
            Data: { Revision: 1, Mode: 'new' }
        });

        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({
            acknowledged: true, revision: 1, contentHash: HASH
        });
        expect(settings).toEqual({ Revision: 1, Mode: 'new' });
    });

    it('coalesces queued writes to the latest intent while resolving every caller from its acknowledgement', async () => {
        const settings = own({ Revision: 0, Mode: 'base' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        let releaseFirst!: (value: ReturnType<typeof acknowledged>) => void;
        const firstResponse = new Promise<ReturnType<typeof acknowledged>>(resolve => { releaseFirst = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockReturnValueOnce(firstResponse)
            .mockResolvedValueOnce(acknowledged('settings.json', 2, { Mode: 'third' }));

        settings.Mode = 'first';
        const first = JC.saveUserSettings!('settings.json', settings);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));
        settings.Mode = 'second';
        const second = JC.saveUserSettings!('settings.json', settings);
        settings.Mode = 'third';
        const third = JC.saveUserSettings!('settings.json', settings);

        releaseFirst(acknowledged('settings.json', 1, { Mode: 'first' }));
        await expect(first).resolves.toMatchObject({ revision: 1 });
        await expect(second).resolves.toMatchObject({ revision: 2 });
        await expect(third).resolves.toMatchObject({ revision: 2 });
        expect(ajax).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(ajax.mock.calls[1][0].data))).toEqual({ Revision: 1, Mode: 'third' });
        expect(settings).toEqual({ Revision: 2, Mode: 'third' });
    });

    it('queues a revert to acknowledged content while a different write is in flight', async () => {
        const settings = own({ Revision: 0, Enabled: false });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce(acknowledged('settings.json', 0, { Enabled: false }));
        await JC.saveUserSettings!('settings.json', settings);

        let releaseEnable!: (value: ReturnType<typeof acknowledged>) => void;
        const enableResponse = new Promise<ReturnType<typeof acknowledged>>(resolve => { releaseEnable = resolve; });
        ajax.mockReturnValueOnce(enableResponse)
            .mockResolvedValueOnce(acknowledged('settings.json', 2, { Enabled: false }));

        settings.Enabled = true;
        const enable = JC.saveUserSettings!('settings.json', settings);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
        settings.Enabled = false;
        const revert = JC.saveUserSettings!('settings.json', settings);
        releaseEnable(acknowledged('settings.json', 1, { Enabled: true }));

        await expect(enable).resolves.toMatchObject({ revision: 1 });
        await expect(revert).resolves.toMatchObject({ revision: 2, deduplicated: false });
        expect(ajax).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(ajax.mock.calls[2][0].data))).toEqual({ Revision: 1, Enabled: false });
        expect(settings).toEqual({ Revision: 2, Enabled: false });
    });

    it('preserves a newer unsaved field edit when an earlier acknowledgement publishes', async () => {
        const settings = own({ Revision: 0, First: 'base', Second: 'base' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        let release!: (value: ReturnType<typeof acknowledged>) => void;
        const response = new Promise<ReturnType<typeof acknowledged>>(resolve => { release = resolve; });
        vi.spyOn(ApiClient, 'ajax').mockReturnValue(response);

        settings.First = 'saved';
        const saving = JC.saveUserSettings!('settings.json', settings);
        settings.Second = 'newer-unsaved';
        release(acknowledged('settings.json', 1, { First: 'saved', Second: 'base' }));

        await expect(saving).resolves.toMatchObject({ revision: 1 });
        expect(settings).toEqual({ Revision: 1, First: 'saved', Second: 'newer-unsaved' });
    });

    it('never rebases a queued edit from a predecessor that failed before acknowledgement', async () => {
        const settings = own({ Revision: 0, First: 'base', Second: 'base' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        let rejectFirst!: (reason: unknown) => void;
        const firstResponse = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
        const authoritative = { Revision: 1, First: 'remote', Second: 'base' };
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockReturnValueOnce(firstResponse)
            .mockRejectedValueOnce(httpError(409, {
                success: false,
                conflict: true,
                file: 'settings.json',
                revision: 1,
                contentHash: HASH,
                data: authoritative
            }))
            // This would be reached by the old false-success rebase, which
            // silently omitted First because it treated the failed intent as base.
            .mockResolvedValueOnce(acknowledged('settings.json', 2, {
                First: 'remote',
                Second: 'local-b'
            }));

        settings.First = 'local-a';
        const first = JC.saveUserSettings!('settings.json', settings);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));
        settings.Second = 'local-b';
        const second = JC.saveUserSettings!('settings.json', settings);
        rejectFirst(httpError(503));

        await expect(first).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
        await expect(second).rejects.toMatchObject({ kind: 'conflict', status: 409 });
        expect(ajax).toHaveBeenCalledTimes(2);
        expect(settings).toEqual(authoritative);
    });

    it.each([
        ['settings.json', { Revision: 0, Mode: 'old' }, (v: any) => { v.Mode = 'new'; }],
        ['shortcuts.json', { Revision: 0, Shortcuts: [] }, (v: any) => { v.Shortcuts.push({ Name: 'Open', Key: 'O' }); }],
        ['elsewhere.json', { Revision: 0, Region: 'AU', Regions: [], Services: [] }, (v: any) => { v.Region = 'NZ'; }],
        ['theme.json', { Revision: 0, SchemaVersion: 2, ActiveProfileId: 'default', Profiles: [] },
            (v: any) => { v.ActiveProfileId = 'cinema'; }]
    ])('classifies every HTTP failure and restores %s exactly', async (file, initial, mutate) => {
        for (const status of [400, 401, 409, 429, 500, 503]) {
            startSession();
            const value = own(structuredClone(initial));
            JC.rememberUserSettingsSnapshot!(file, value);
            mutate(value);
            const authoritative = status === 409 ? structuredClone(initial) as Record<string, unknown> : undefined;
            if (authoritative) {
                if (file === 'settings.json') authoritative.Mode = 'remote';
                if (file === 'shortcuts.json') authoritative.Shortcuts = [{ Name: 'Other', Key: 'X' }];
                if (file === 'elsewhere.json') authoritative.Region = 'US';
                if (file === 'theme.json') authoritative.ActiveProfileId = 'remote';
                authoritative.Revision = 1;
            }
            vi.spyOn(ApiClient, 'ajax').mockRejectedValueOnce(httpError(status, authoritative ? {
                success: false,
                conflict: true,
                file,
                revision: 0,
                contentHash: HASH,
                data: authoritative
            } : undefined));

            const rejection = JC.saveUserSettings!(file, value);
            await expect(rejection).rejects.toBeInstanceOf(UserSettingsPersistenceError);
            await expect(rejection).rejects.toMatchObject({
                kind: status === 400 ? 'validation'
                    : status === 401 ? 'authorization'
                        : status === 409 ? 'conflict'
                            : 'unavailable',
                status
            });
            expect(value).toEqual(status === 409 ? authoritative : initial);
            vi.restoreAllMocks();
            vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
        }
    });

    it('safely rebases disjoint local settings fields on authoritative 409 state', async () => {
        const settings = own({ Revision: 0, LocalMode: 'old', RemoteMode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.LocalMode = 'new';
        const authoritative = { Revision: 1, LocalMode: 'old', RemoteMode: 'remote' };
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(httpError(409, {
                success: false,
                conflict: true,
                file: 'settings.json',
                revision: 1,
                contentHash: HASH,
                data: authoritative
            }))
            .mockResolvedValueOnce(acknowledged('settings.json', 2, {
                LocalMode: 'new',
                RemoteMode: 'remote'
            }));

        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({ revision: 2 });
        expect(settings).toEqual({ Revision: 2, LocalMode: 'new', RemoteMode: 'remote' });
        expect(ajax).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(String(ajax.mock.calls[1][0].data));
        expect(secondBody).toEqual({ Revision: 1, LocalMode: 'new', RemoteMode: 'remote' });
    });

    it('returns the exact rebased acknowledgement to every joined waiter', async () => {
        const firstTarget = own({ Revision: 0, Profile: 'base', Schedule: 'base' });
        JC.rememberUserSettingsSnapshot!('theme.json', firstTarget);
        let rejectInitial: (reason: unknown) => void = () => undefined;
        const initial = new Promise<never>((_resolve, reject) => { rejectInitial = reject; });
        const authoritative = { Revision: 1, Profile: 'base', Schedule: 'remote' };
        const acknowledgedData = { Revision: 2, Profile: 'local', Schedule: 'remote' };
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockReturnValueOnce(initial)
            .mockResolvedValueOnce(acknowledged('theme.json', 2, acknowledgedData));

        firstTarget.Profile = 'local';
        const first = JC.saveUserSettings!('theme.json', firstTarget);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledOnce());
        const joinedTarget = own(structuredClone(firstTarget));
        const joined = JC.saveUserSettings!('theme.json', joinedTarget);
        rejectInitial(httpError(409, {
            success: false,
            conflict: true,
            file: 'theme.json',
            revision: 1,
            contentHash: HASH,
            data: authoritative,
        }));

        const [firstResult, joinedResult] = await Promise.all([first, joined]);
        expect(firstResult).toMatchObject({ data: acknowledgedData });
        expect(joinedResult).toMatchObject({ data: acknowledgedData });
        expect(firstResult.data).not.toBe(joinedResult.data);
        expect(firstTarget).toEqual(acknowledgedData);
        expect(joinedTarget).toEqual({ Revision: 0, Profile: 'local', Schedule: 'base' });
        expect(JSON.parse(String(ajax.mock.calls[1][0].data))).toEqual({
            Revision: 1, Profile: 'local', Schedule: 'remote',
        });
    });

    it('rejects a same-field conflict and adopts the authoritative state', async () => {
        const settings = own({ Revision: 0, Mode: 'base' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'local';
        vi.spyOn(ApiClient, 'ajax').mockRejectedValue(httpError(409, {
            Success: false,
            Conflict: true,
            File: 'settings.json',
            Revision: 1,
            ContentHash: HASH,
            Data: { Revision: 1, Mode: 'remote' }
        }));

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'conflict', status: 409
        });
        expect(settings).toEqual({ Revision: 1, Mode: 'remote' });
    });

    it('never deduplicates against stale acknowledged content while conflict-latched', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce(acknowledged('settings.json', 0, { Mode: 'old' }))
            .mockRejectedValueOnce(httpError(409, {
                success: false,
                conflict: true,
                file: 'settings.json',
                revision: 1,
                contentHash: HASH,
                data: { Revision: 1, Mode: 'remote' }
            }));
        await JC.saveUserSettings!('settings.json', settings);

        settings.Mode = 'local';
        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'conflict', status: 409
        });
        settings.Mode = 'old';

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'conflict', status: 409, retryable: false
        });
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['settings.json', 'network', { Revision: 0, Mode: 'old' }, { Mode: 'new' }],
        ['settings.json', 'abort', { Revision: 0, Mode: 'old' }, { Mode: 'new' }],
        ['shortcuts.json', 'network', { Revision: 0, Shortcuts: [] }, { Shortcuts: [{ Name: 'Open', Key: 'O' }] }],
        ['shortcuts.json', 'abort', { Revision: 0, Shortcuts: [] }, { Shortcuts: [{ Name: 'Open', Key: 'O' }] }],
        ['elsewhere.json', 'network', { Revision: 0, Region: 'AU', Regions: [], Services: [] }, { Region: 'NZ', Regions: [], Services: [] }],
        ['elsewhere.json', 'abort', { Revision: 0, Region: 'AU', Regions: [], Services: [] }, { Region: 'NZ', Regions: [], Services: [] }],
        ['theme.json', 'network', { Revision: 0, SchemaVersion: 2, ActiveProfileId: 'default', Profiles: [] }, { SchemaVersion: 2, ActiveProfileId: 'cinema', Profiles: [] }],
        ['theme.json', 'abort', { Revision: 0, SchemaVersion: 2, ActiveProfileId: 'default', Profiles: [] }, { SchemaVersion: 2, ActiveProfileId: 'cinema', Profiles: [] }]
    ])('resolves an ambiguous %s %s after evidence proves the exact content committed', async (file, kind, initial, desired) => {
        const value = own(structuredClone(initial));
        JC.rememberUserSettingsSnapshot!(file, value);
        Object.assign(value, structuredClone(desired));
        const failure = kind === 'abort'
            ? Object.assign(new Error('aborted'), { name: 'AbortError' })
            : new TypeError('Failed to fetch');
        const committed = acknowledged(file, 1, desired);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(committed);

        await expect(JC.saveUserSettings!(file, value)).resolves.toMatchObject({
            acknowledged: true,
            revision: 1
        });
        expect(value).toEqual({ Revision: 1, ...desired });
        expect(String(ajax.mock.calls[1][0].url)).toContain(`/${file}/evidence`);
    });

    it('does not retry an aborted write when evidence proves the server stayed unchanged', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'new';
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            .mockResolvedValueOnce(acknowledged('settings.json', 0, { Mode: 'old' }));

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'cancelled', ambiguous: true
        });
        expect(ajax).toHaveBeenCalledTimes(2);
        expect(settings.Mode).toBe('new');
    });

    it('reports repeated unverified unchanged writes as unavailable without permanently conflict-locking the file', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'new';
        const unchanged = acknowledged('settings.json', 0, { Mode: 'old' });
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(new TypeError('lost response one'))
            .mockResolvedValueOnce(unchanged)
            .mockRejectedValueOnce(new TypeError('lost response two'))
            .mockResolvedValueOnce(unchanged)
            .mockResolvedValueOnce(acknowledged('settings.json', 1, { Mode: 'new' }));

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({
            kind: 'unavailable', retryable: true, ambiguous: true
        });
        await expect(JC.saveUserSettings!('settings.json', settings)).resolves.toMatchObject({ revision: 1 });
        expect(ajax).toHaveBeenCalledTimes(5);
    });

    it('publishes the failure event for a rejection that occurs before queueing', async () => {
        const event = vi.fn();
        document.addEventListener('jc:user-settings-save-error', event, { once: true });

        await expect(JC.saveUserSettings!('unsupported.json', own({ Revision: 0 }))).rejects.toMatchObject({
            kind: 'validation'
        });
        expect(event).toHaveBeenCalledOnce();
        expect((event.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
            file: 'unsupported.json', kind: 'validation'
        });
    });

    it('keeps local intent dirty when an ambiguous write cannot be verified', async () => {
        const elsewhere = own({ Revision: 0, Region: 'AU', Regions: [], Services: [] });
        JC.rememberUserSettingsSnapshot!('elsewhere.json', elsewhere);
        elsewhere.Region = 'NZ';
        vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(JC.saveUserSettings!('elsewhere.json', elsewhere)).rejects.toMatchObject({
            kind: 'unavailable', ambiguous: true
        });
        expect(elsewhere.Region).toBe('NZ');
    });

    it('rejects malformed 200 responses and never records them as saved', async () => {
        const settings = own({ Revision: 0, Mode: 'old' });
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
        settings.Mode = 'new';
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({ success: true });

        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({ kind: 'protocol' });
        expect(settings).toEqual({ Revision: 0, Mode: 'old' });
        settings.Mode = 'new';
        await expect(JC.saveUserSettings!('settings.json', settings)).rejects.toMatchObject({ kind: 'protocol' });
        expect(ajax).toHaveBeenCalledTimes(2);
    });
});
