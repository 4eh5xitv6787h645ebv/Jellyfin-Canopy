// Lazy page-owned target handoff. Importing is pure; only explicit staging
// registers guards. Keep this module out of eager/shared feature graphs.

import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';

const ADMIN_TARGET_HANDOFF_TTL_MS = 15_000;
const HANDOFF_RESET_OWNER = 'hidden-content-page-handoff';
const PAGE_NAV_ATTR = 'data-jc-page-nav';
const HANDOFF_TOKEN_PATTERN = /^[a-z0-9:-]{1,128}$/i;
const MAX_SERVER_ID_LENGTH = 256;

interface ActivePageHandoff {
    identity: IdentityContext;
    originHash: string;
    token: string;
}

let activePageHandoff: ActivePageHandoff | null = null;
let sequence = 0;
let stopNavigationWatch: (() => void) | null = null;
let stopIdentityReset: (() => void) | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;

function normalizeUserId(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().replace(/-/g, '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(normalized) ? normalized : '';
}

function validServerId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_SERVER_ID_LENGTH
        && value.trim() === value;
}

function parseCanonicalInteger(value: unknown): number | null {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validToken(value: unknown): value is string {
    return typeof value === 'string' && HANDOFF_TOKEN_PATTERN.test(value);
}

function currentHashPath(): string {
    const rawHash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
    return rawHash.split('?')[0];
}

function stopGuards(expectedToken?: string): void {
    if (expectedToken && activePageHandoff?.token !== expectedToken) return;
    stopNavigationWatch?.();
    stopNavigationWatch = null;
    stopIdentityReset?.();
    stopIdentityReset = null;
    if (expiry !== null) {
        clearTimeout(expiry);
        expiry = null;
    }
    activePageHandoff = null;
}

function clearDomEvidence(): void {
    const root = document.documentElement;
    delete root.dataset.jcHiddenAdminActor;
    delete root.dataset.jcHiddenAdminTarget;
    delete root.dataset.jcHiddenAdminHandoff;
    delete root.dataset.jcHiddenAdminServer;
    delete root.dataset.jcHiddenAdminEpoch;
    delete root.dataset.jcHiddenAdminStagedAt;
}

/** Token-scoped cleanup prevents an older launch from retiring newer evidence. */
export function clearAdminTargetHandoff(expectedToken?: string): void {
    const rootToken = document.documentElement.dataset.jcHiddenAdminHandoff || '';
    if (expectedToken && rootToken !== expectedToken) {
        stopGuards(expectedToken);
        return;
    }

    const retiredToken = rootToken || activePageHandoff?.token || '';
    clearDomEvidence();
    stopGuards(expectedToken);
    if (validToken(retiredToken)) {
        window.dispatchEvent(new CustomEvent('jc-hidden-admin-handoff-consumed', {
            detail: { token: retiredToken },
        }));
    }
}

function stillOwnsIntendedNavigation(handoff: ActivePageHandoff): boolean {
    if (currentHashPath() === '/hidden-content') return true;

    // Emby.Page.show can announce navigation before committing the new hash.
    // The early-mask marker proves that one pre-commit event belongs to this
    // launch only while the hash remains exactly where staging began.
    return window.location.hash === handoff.originHash
        && document.documentElement.getAttribute(PAGE_NAV_ATTR) === 'hidden-content';
}

function guardActivePageHandoff(handoff: ActivePageHandoff): void {
    stopIdentityReset = JC.identity.registerReset(
        HANDOFF_RESET_OWNER,
        () => clearAdminTargetHandoff(handoff.token),
    );

    const navigation = JC.core.navigation;
    if (navigation) {
        stopNavigationWatch = navigation.onNavigate(() => {
            queueMicrotask(() => {
                if (activePageHandoff?.token !== handoff.token) return;
                const domToken =
                    document.documentElement.dataset.jcHiddenAdminHandoff;
                if (domToken !== handoff.token) {
                    stopGuards(handoff.token);
                    return;
                }
                if (!JC.identity.isCurrent(handoff.identity)
                    || !stillOwnsIntendedNavigation(handoff)) {
                    clearAdminTargetHandoff(handoff.token);
                }
            });
        });
    }

    expiry = setTimeout(
        () => clearAdminTargetHandoff(handoff.token),
        ADMIN_TARGET_HANDOFF_TTL_MS,
    );
}

/** Stage a validated target from the already-loaded page facade. */
export function stageAdminTargetHandoff(
    actorUserId: string,
    targetUserId: string,
    handoffToken?: string,
): string | null {
    const actor = normalizeUserId(actorUserId);
    const target = normalizeUserId(targetUserId);
    const currentApiUser = normalizeUserId(ApiClient.getCurrentUserId?.());
    const identity = JC.identity.capture();
    const token = handoffToken === undefined
        ? `page:${++sequence}`
        : validToken(handoffToken)
            ? handoffToken
            : '';
    if (!actor
        || !target
        || !token
        || !identity
        || !validServerId(identity.serverId)
        || !Number.isSafeInteger(identity.epoch)
        || identity.epoch < 0
        || !JC.identity.isCurrent(identity)
        || normalizeUserId(identity.userId) !== actor
        || currentApiUser !== actor
        || target === actor) {
        return null;
    }

    // All validation happens before replacement so a malformed stale call
    // cannot retire a newer accepted handoff.
    clearAdminTargetHandoff();
    const handoff: ActivePageHandoff = {
        identity,
        originHash: window.location.hash,
        token,
    };
    activePageHandoff = handoff;

    const root = document.documentElement;
    root.dataset.jcHiddenAdminActor = actor;
    root.dataset.jcHiddenAdminTarget = target;
    root.dataset.jcHiddenAdminHandoff = token;
    root.dataset.jcHiddenAdminServer = identity.serverId;
    root.dataset.jcHiddenAdminEpoch = String(identity.epoch);
    root.dataset.jcHiddenAdminStagedAt = String(Date.now());
    guardActivePageHandoff(handoff);
    return token;
}

/** Consume only when actor, server, epoch, age, token, and identity all agree. */
export function consumeAdminTargetHandoff(): string | null {
    const root = document.documentElement;
    const actor = normalizeUserId(root.dataset.jcHiddenAdminActor);
    const target = normalizeUserId(root.dataset.jcHiddenAdminTarget);
    const token = root.dataset.jcHiddenAdminHandoff;
    const serverId = root.dataset.jcHiddenAdminServer;
    const epoch = parseCanonicalInteger(root.dataset.jcHiddenAdminEpoch);
    const stagedAt = parseCanonicalInteger(root.dataset.jcHiddenAdminStagedAt);
    const identity = JC.identity.capture();
    const age = stagedAt === null ? -1 : Date.now() - stagedAt;
    const valid = !!actor
        && !!target
        && actor !== target
        && validToken(token)
        && validServerId(serverId)
        && epoch !== null
        && stagedAt !== null
        && age >= 0
        && age <= ADMIN_TARGET_HANDOFF_TTL_MS
        && !!identity
        && JC.identity.isCurrent(identity)
        && normalizeUserId(identity.userId) === actor
        && normalizeUserId(ApiClient.getCurrentUserId?.()) === actor
        && identity.serverId === serverId
        && identity.epoch === epoch;

    clearAdminTargetHandoff(token);
    return valid ? target : null;
}
