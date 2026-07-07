// Spoiler Guard identity tags: the tagged-image-URL scheme that attributes
// anonymous image requests to a user WITHOUT the client IP (the reverse-proxy
// fix). Authenticated item DTO responses get every image tag stamped with the
// requesting user's "-jeu{12hex}" marker; clients echo the tag verbatim on
// their image requests; the image filter resolves the marker back to the user.
//
// API-level by design: the signal lives on the wire (DTO tag values and raw
// image bytes for ANONYMOUS fetches), not in the browser UI — and the whole
// point is behavior for native clients that Playwright can't emulate through
// the web bundle. All requests in one worker share the runner's IP, which
// makes the assertions strict: with BOTH test users holding sessions on that
// shared IP, only the marker can explain per-user divergence in the bytes.
//
// Content-independent like spoiler-guard.spec.ts: the target series/episode is
// discovered via the REST API; every test SKIPs when the master switch is off;
// all guard state is restored in finally blocks.
import { test, expect } from './fixtures/auth';
import { USERS } from './fixtures/auth';
import { authenticate, api, authHeader, type Session } from './fixtures/api';

const BASE = process.env.JF_BASE_URL || 'http://localhost:8099';

// SpoilerIdentityService.MarkerSentinel + MarkerHexLength on the server.
const MARKER = /-jeu[0-9a-f]{12}$/;

interface Target {
    seriesId: string;
    episodeId: string;
    episodeTagAdmin: string; // stamped Primary tag as the admin sees it
}

async function spoilerBlurEnabled(): Promise<boolean> {
    const cfg = await api<{ SpoilerBlurEnabled?: boolean }>(BASE, '/JellyfinElevate/public-config');
    return cfg?.SpoilerBlurEnabled === true;
}

/** Anonymous (token-less, cookie-less) image fetch — what a native TV client does. */
async function fetchImageAnon(episodeId: string, tag: string): Promise<{ status: number; bytes: Buffer }> {
    const res = await fetch(`${BASE}/Items/${episodeId}/Images/Primary?tag=${encodeURIComponent(tag)}`);
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** The stamped Primary tag of an episode as one authenticated user sees it. */
async function primaryTagFor(session: Session, episodeId: string): Promise<string> {
    const dto = await api<{ ImageTags?: Record<string, string> }>(
        BASE,
        `/Users/${session.userId}/Items/${episodeId}?Fields=ImageTags`,
        session.token
    );
    const tag = dto?.ImageTags?.Primary;
    expect(tag, 'target episode lost its Primary image tag').toBeTruthy();
    return tag as string;
}

test.describe('spoiler guard identity tags (reverse-proxy-safe attribution)', () => {
    let enabled = false;
    let admin: Session;
    let user: Session;
    let target: Target | null = null;

    test.beforeAll(async () => {
        enabled = await spoilerBlurEnabled();
        if (!enabled) return;
        admin = await authenticate(BASE, USERS.admin.username, USERS.admin.password);
        user = await authenticate(BASE, USERS.user.username, USERS.user.password);

        // Find a series with an unwatched episode that has a Primary image.
        const series = await api<{ Items: { Id: string }[] }>(
            BASE,
            '/Items?IncludeItemTypes=Series&Recursive=true&Limit=25&SortBy=SortName',
            admin.token
        );
        for (const s of series?.Items ?? []) {
            const eps = await api<{ Items: { Id: string; ImageTags?: Record<string, string>; UserData?: { Played?: boolean } }[] }>(
                BASE,
                `/Shows/${s.Id}/Episodes?Fields=ImageTags&UserId=${admin.userId}`,
                admin.token
            );
            const ep = (eps?.Items ?? []).find((e) => e.ImageTags?.Primary && e.UserData?.Played !== true);
            if (ep) {
                target = { seriesId: s.Id, episodeId: ep.Id, episodeTagAdmin: ep.ImageTags!.Primary };
                break;
            }
        }
    });

    test('authenticated DTO responses carry per-user markers (distinct per user, blurhashes re-keyed)', async () => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no unwatched episode with a Primary image found');

        const adminTag = await primaryTagFor(admin, target!.episodeId);
        const userTag = await primaryTagFor(user, target!.episodeId);

        expect(adminTag, 'admin tag must end with the marker suffix').toMatch(MARKER);
        expect(userTag, 'user tag must end with the marker suffix').toMatch(MARKER);
        expect(adminTag.match(MARKER)![0], 'markers must differ per user').not.toBe(userTag.match(MARKER)![0]);

        // Blurhash dictionaries must be re-keyed to the STAMPED tag strings —
        // clients look hashes up by the exact tag value they hold.
        const dto = await api<{
            ImageTags?: Record<string, string>;
            ImageBlurHashes?: Record<string, Record<string, string>>;
        }>(BASE, `/Users/${user.userId}/Items/${target!.episodeId}?Fields=ImageTags`, user.token);
        const primaryHashes = dto?.ImageBlurHashes?.Primary;
        if (primaryHashes && Object.keys(primaryHashes).length > 0) {
            expect(
                Object.keys(primaryHashes).some((k) => MARKER.test(k)),
                'ImageBlurHashes.Primary keys must be re-keyed to stamped tags'
            ).toBe(true);
        }
    });

    test('anonymous image fetches resolve per-user by marker on a shared IP', async () => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no unwatched episode with a Primary image found');

        // Guard the series for the ADMIN only.
        await api(BASE, `/JellyfinElevate/spoiler-blur/series/${target!.seriesId}?enabled=true`, admin.token, {
            method: 'POST',
        });
        try {
            // Tags must be re-read AFTER guarding: the strip filter adds its
            // sb- cache-bust prefix for the guarding user.
            const adminTag = await primaryTagFor(admin, target!.episodeId);
            const userTag = await primaryTagFor(user, target!.episodeId);

            const asAdmin = await fetchImageAnon(target!.episodeId, adminTag);
            const asUser = await fetchImageAnon(target!.episodeId, userTag);
            expect(asAdmin.status).toBe(200);
            expect(asUser.status).toBe(200);

            // The guarding user's marker gets protected bytes; the other
            // user's marker gets different (clean) bytes — on the SAME
            // requesting IP, so only the marker can explain the divergence.
            expect(asAdmin.bytes.equals(asUser.bytes), 'guarded vs unguarded user must receive different bytes').toBe(
                false
            );

            // Ground truth: the non-guarding user's anonymous bytes must be
            // IDENTICAL to their fully authenticated fetch (ClaimsPrincipal
            // tier) — proving the marker resolved to that exact user.
            const authRes = await fetch(
                `${BASE}/Items/${target!.episodeId}/Images/Primary?tag=${encodeURIComponent(userTag)}`,
                { headers: { Authorization: authHeader(user.token) } }
            );
            const authBytes = Buffer.from(await authRes.arrayBuffer());
            expect(asUser.bytes.equals(authBytes), 'marker attribution must match authenticated ground truth').toBe(
                true
            );
        } finally {
            await api(BASE, `/JellyfinElevate/spoiler-blur/series/${target!.seriesId}?enabled=false`, admin.token, {
                method: 'POST',
            }).catch(() => undefined);
        }
    });

    test('unknown or absent markers fail safe (legacy ladder, no errors)', async () => {
        test.skip(!enabled, 'SpoilerBlurEnabled is off on the target server');
        test.skip(!target, 'no unwatched episode with a Primary image found');

        const userTag = await primaryTagFor(user, target!.episodeId);
        const baseTag = userTag.replace(MARKER, '');

        // A marker naming no current user must not error — it falls through
        // to the session-by-IP ladder.
        const unknown = await fetchImageAnon(target!.episodeId, `${baseTag}-jeu000000000000`);
        expect(unknown.status).toBe(200);
        expect(unknown.bytes.length).toBeGreaterThan(0);

        // A plain unmarked tag (pre-update client cache) must keep working.
        const plain = await fetchImageAnon(target!.episodeId, baseTag);
        expect(plain.status).toBe(200);
        expect(plain.bytes.length).toBeGreaterThan(0);
    });
});
