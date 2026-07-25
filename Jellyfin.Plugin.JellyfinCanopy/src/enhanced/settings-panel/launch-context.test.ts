import { describe, expect, it } from 'vitest';
import { parseSettingsPreferencesRoute } from './launch-context';

const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_TARGET = 'cccccccccccccccccccccccccccccccc';
const DASHED_TARGET = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function route(
    pathname: string,
    search = '',
    hash = '',
): { pathname: string; search: string; hash: string } {
    return { pathname, search, hash };
}

describe('parseSettingsPreferencesRoute', () => {
    it('parses modern routes through a proxy prefix', () => {
        expect(parseSettingsPreferencesRoute(
            route('/proxy/web/mypreferencesmenu', `?userId=${TARGET}`),
        )).toEqual({ kind: 'preferences', targetUserId: TARGET });
    });

    it('parses legacy hash routes with optional html and bang forms', () => {
        expect(parseSettingsPreferencesRoute(
            route('/web/', '', `#/mypreferencesmenu.html?userId=${DASHED_TARGET}`),
        )).toEqual({ kind: 'preferences', targetUserId: TARGET });
        expect(parseSettingsPreferencesRoute(
            route('/web/', '', '#!/myPreferencesMenu'),
        )).toEqual({ kind: 'preferences', targetUserId: null });
    });

    it('uses the hash query instead of the outer document query', () => {
        expect(parseSettingsPreferencesRoute(
            route(
                '/web/',
                `?userId=${OTHER_TARGET}`,
                `#/mypreferencesmenu?userId=${TARGET}`,
            ),
        )).toEqual({ kind: 'preferences', targetUserId: TARGET });
    });

    it('accepts only one exact N- or D-format user id', () => {
        expect(parseSettingsPreferencesRoute(
            route('/web/mypreferencesmenu.html', `?userId=${DASHED_TARGET.toUpperCase()}`),
        )).toEqual({ kind: 'preferences', targetUserId: TARGET });
        expect(parseSettingsPreferencesRoute(
            route('/web/mypreferencesmenu', '?userId=bbbb-bbbb'),
        )).toEqual({ kind: 'malformed-target' });
        expect(parseSettingsPreferencesRoute(
            route('/web/mypreferencesmenu', `?userId=${TARGET}&UserId=${OTHER_TARGET}`),
        )).toEqual({ kind: 'malformed-target' });
        expect(parseSettingsPreferencesRoute(
            route('/web/mypreferencesmenu', '?userId='),
        )).toEqual({ kind: 'malformed-target' });
    });

    it('distinguishes a self route from an unrelated page', () => {
        expect(parseSettingsPreferencesRoute(
            route('/web/mypreferencesmenu.html', '?tab=controls'),
        )).toEqual({ kind: 'preferences', targetUserId: null });
        expect(parseSettingsPreferencesRoute(
            route('/web/home.html', `?userId=${TARGET}`),
        )).toEqual({ kind: 'not-preferences' });
    });
});
