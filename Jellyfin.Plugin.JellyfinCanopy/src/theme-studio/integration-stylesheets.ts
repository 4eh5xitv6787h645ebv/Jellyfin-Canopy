import { assetUrl, type EmbeddedAssetKey } from '../core/asset-urls';
import { JC } from '../globals';

export const SEERR_STYLESHEET_ID = 'jc-theme-studio-seerr-surfaces';
export const ARR_STYLESHEET_ID = 'jc-theme-studio-arr-surfaces';
export const EXTERNAL_STYLESHEET_ID = 'jc-theme-studio-external-surfaces';

interface IntegrationStyleDefinition {
    readonly id: string;
    readonly asset: EmbeddedAssetKey;
    readonly enabled: () => boolean;
}

function authenticatedAdministrator(): boolean {
    return JC.currentUser?.Policy?.IsAdministrator === true;
}

export function seerrIntegrationStylesEnabled(): boolean {
    return JC.pluginConfig?.SeerrEnabled === true
        && JC.pluginConfig?.SeerrConfigured === true;
}

export function arrIntegrationStylesEnabled(): boolean {
    if (!authenticatedAdministrator()) return false;
    const searchServiceConfigured = JC.pluginConfig?.SonarrConfigured === true
        || JC.pluginConfig?.RadarrConfigured === true;
    const linkServiceConfigured = searchServiceConfigured
        || JC.pluginConfig?.BazarrConfigured === true;
    const linksCanRender = linkServiceConfigured
        && (JC.pluginConfig?.ArrLinksEnabled === true
            || JC.pluginConfig?.ArrTagsShowAsLinks === true);
    const searchCanRender = searchServiceConfigured
        && JC.pluginConfig?.ArrSearchEnabled !== false;
    return linksCanRender || searchCanRender;
}

export function externalIntegrationStylesEnabled(): boolean {
    const tmdb = JC.pluginConfig?.TmdbEnabled === true;
    return (tmdb && JC.pluginConfig?.ElsewhereEnabled === true)
        || (tmdb && JC.pluginConfig?.ShowReviews === true)
        || JC.pluginConfig?.ShowUserReviews === true
        || JC.pluginConfig?.LetterboxdEnabled === true
        || (tmdb && JC.pluginConfig?.ShowReleaseDates === true);
}

const DEFINITIONS: readonly IntegrationStyleDefinition[] = Object.freeze([
    {
        id: SEERR_STYLESHEET_ID,
        asset: 'theme-studio/seerr-surfaces.css',
        enabled: seerrIntegrationStylesEnabled,
    },
    {
        id: ARR_STYLESHEET_ID,
        asset: 'theme-studio/arr-surfaces.css',
        enabled: arrIntegrationStylesEnabled,
    },
    {
        id: EXTERNAL_STYLESHEET_ID,
        asset: 'theme-studio/external-surfaces.css',
        enabled: externalIntegrationStylesEnabled,
    },
]);

const owners = new Map<string, object>();

/**
 * Installs only the integration presentation closures that can render for the
 * current live configuration. Predicates consume booleans, never service URLs,
 * credentials or provider payloads.
 */
export function installIntegrationStylesheets(owner: object): () => void {
    for (const definition of DEFINITIONS) {
        if (!definition.enabled()) {
            owners.delete(definition.id);
            document.getElementById(definition.id)?.remove();
            continue;
        }
        const existing = document.getElementById(definition.id);
        const link = existing instanceof HTMLLinkElement ? existing : document.createElement('link');
        if (existing && existing !== link) existing.remove();
        link.id = definition.id;
        link.rel = 'stylesheet';
        link.dataset.jcOwner = 'theme-studio';
        link.dataset.jcIntegration = definition.asset.split('/').at(-1)!.replace('-surfaces.css', '');
        const href = assetUrl(definition.asset);
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
        if (!link.isConnected) document.head.append(link);
        owners.set(definition.id, owner);
    }

    return () => {
        for (const definition of DEFINITIONS) {
            if (owners.get(definition.id) !== owner) continue;
            owners.delete(definition.id);
            document.getElementById(definition.id)?.remove();
        }
    };
}
