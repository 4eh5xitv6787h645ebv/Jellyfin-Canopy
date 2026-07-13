// src/seerr/more-info-modal/render.ts
// Static HTML builders for the more-info modal body (header, panels,
// crew/cast, trailers, keywords, collection card).
import { JC } from '../../globals';
// PERF(R6): no remote assets — flag/icon images served from the local asset cache.
import { assetUrl, flagPngUrl } from '../../core/asset-urls';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { internal } from './internal';
const escapeHtml = JC.escapeHtml;

/**
 * Build the modal content HTML
 */
function buildModalContent(data: any, mediaType: any) {
const title = mediaType === 'movie' ? data.title : data.name;
const releaseDate = mediaType === 'movie' ? data.releaseDate : data.firstAirDate;
const runtime = mediaType === 'movie'
    ? `${data.runtime} minutes`
    : data.episodeRunTime?.length ? `${data.episodeRunTime[0]} min episodes` : 'N/A';

const year = releaseDate ? new Date(releaseDate).getFullYear() : 'N/A';
const budget = data.budget ? internal.formatCurrency(data.budget) : null;
const revenue = data.revenue ? internal.formatCurrency(data.revenue) : null;

const backdropUrl = data.backdropPath
    ? `https://image.tmdb.org/t/p/original${data.backdropPath}`
    : '';

const posterUrl = data.posterPath
    ? `https://image.tmdb.org/t/p/w500${data.posterPath}`
    : '';

return `
    <div class="modal-overlay">
        <div class="modal-container">
            <button class="modal-refresh" aria-label="Refresh" title="Refresh status">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path>
                </svg>
            </button>
            <button class="modal-close" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>

            <div class="modal-backdrop" style="background-image: url('${escapeHtml(backdropUrl)}');">
                <div class="jc-modal-backdrop-overlay"></div>
            </div>

            <div class="modal-content">
                <div class="modal-main">
                    <div class="modal-left">
                        <div class="header-section">
                            <div class="header-poster">
                                ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}" />` : ''}
                            </div>
                            <div class="header-info">
                                <div class="title-row">
                                <h1 id="jc-more-info-title" class="title">${escapeHtml(title)} ${year ? `<span class="year">(${year})</span>` : ''}</h1>
                                <div class="title-chip" data-mount="jc-status-chip"></div>
                                </div>
                                <div class="meta-info">
                                    <span class="rating-badge">${escapeHtml(internal.getContentRating(data, mediaType))}</span>
                                    <span class="runtime">${escapeHtml(runtime)}</span>
                                    <span class="genres">${data.genres?.map((g: any) => escapeHtml(g.name)).join(', ') || 'N/A'}</span>
                                </div>
                                ${data.tagline ? `<p class="tagline">${escapeHtml(data.tagline)}</p>` : ''}
                                <div class="jc-downloads" data-mount="jc-downloads"></div>
                                <div class="jc-more-info-actions" data-mount="jc-actions"></div>
                                <div class="jc-more-info-secondary-actions" data-mount="jc-secondary-actions"></div>
                            </div>
                        </div>

                        ${data.overview ? `
                            <div class="overview-section">
                                <h3>${JC.t!('seerr_modal_overview') || 'Overview'}</h3>
                                <p>${escapeHtml(data.overview)}</p>
                            </div>
                        ` : ''}

                        ${buildCrewSection(data, mediaType)}

                        ${buildCastSection(data)}

                        ${buildTrailersSection(data)}

                        ${buildKeywordsSection(data)}
                    </div>

                    <div class="modal-right">
                        ${buildRightPanel(data, mediaType, { budget, revenue, releaseDate, tmdbId: data.id })}
                    </div>
                </div>

                ${mediaType === 'tv' ? internal.buildSeasonsSection(data) : ''}
            </div>
        </div>
    </div>
`;
}

/**
 * Build right panel with ratings and stats
 */
function buildRightPanel(data: any, mediaType: any, { budget, revenue, releaseDate, tmdbId }: any) {
return `
    <div class="jc-more-info-right-panel">
        <div class="jc-more-info-media-ratings" data-mount="ratings">
            ${data.ratings ? internal.buildRatingLogos(data.ratings, data, mediaType, tmdbId) : `
                <div class="jc-more-info-ratings-skeleton">
                    <span class="jc-skel-badge"></span>
                    <span class="jc-skel-badge" style="width:72px"></span>
                </div>
            `}
        </div>
        ${mediaType === 'movie' && data.collection ? buildCollectionCard(data.collection) : ''}
        <div class="jc-more-info-stats-panel">
            <div class="jc-more-info-stat-row">
                <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_status')}</div>
                <div class="jc-more-info-stat-value">${escapeHtml(data.status || 'N/A')}</div>
            </div>

            ${mediaType === 'tv' ? `
                ${data.firstAirDate ? `
                    <div class="jc-more-info-stat-row">
                        <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_first_air_date')}</div>
                        <div class="jc-more-info-stat-value">${new Date(data.firstAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                    </div>
                ` : ''}
                ${data.lastAirDate ? `
                    <div class="jc-more-info-stat-row">
                        <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_last_air_date')}</div>
                        <div class="jc-more-info-stat-value">${new Date(data.lastAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                    </div>
                ` : ''}
            ` : `
                ${releaseDate ? `
                    <div class="jc-more-info-stat-row">
                        <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_release_date')}</div>
                        <div class="jc-more-info-stat-value">${new Date(releaseDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                    </div>
                ` : ''}
            `}

            ${revenue ? `
                <div class="jc-more-info-stat-row">
                    <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_revenue')}</div>
                    <div class="jc-more-info-stat-value">${revenue}</div>
                </div>
            ` : ''}

            ${budget ? `
                <div class="jc-more-info-stat-row">
                    <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_budget')}</div>
                    <div class="jc-more-info-stat-value">${budget}</div>
                </div>
            ` : ''}

            ${data.originalLanguage ? `
                <div class="jc-more-info-stat-row">
                    <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_original_language')}</div>
                    <div class="jc-more-info-stat-value">${escapeHtml(data.originalLanguage.toUpperCase())}</div>
                </div>
            ` : ''}

            ${data.productionCountries?.length ? `
                <div class="jc-more-info-stat-row">
                    <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_production_country')}</div>
                    <div class="jc-more-info-stat-value">${data.productionCountries.map((c: any) => {
                        const disp = c?.name === 'United States of America' ? 'United States' : (c?.name || '');
                        const code = (c?.iso_3166_1 || '').toLowerCase();
                        return `<div><img src="${escapeHtml(flagPngUrl(code))}" alt="${escapeHtml(disp)}" title="${escapeHtml(disp)}" style="margin-right: 6px; vertical-align: middle;" /> ${escapeHtml(disp)}</div>`;
                    }).join('')}</div>
                </div>
            ` : ''}

            ${data.productionCompanies?.length ? `
                <div class="jc-more-info-stat-row">
                    <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_studios')}</div>
                    <div class="jc-more-info-stat-value">${data.productionCompanies.slice(0, 3).map((c: any) => escapeHtml(c.name)).join(', ')}</div>
                </div>
            ` : ''}

            ${buildStreamingProviders(data)}
        </div>
        ${internal.buildMediaFacts(data, mediaType, tmdbId)}
    </div>
`;
}

/**
 * Build streaming providers section
 */
function buildStreamingProviders(data: any) {
// Early exit if TMDB is not configured
if (!JC?.pluginConfig?.TmdbEnabled) {
    return '';
}

// Resolve region: prefer Elsewhere user setting → plugin fallback → US
const region = ((JC?.userConfig?.elsewhere as any)?.Region || JC?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

// watchProviders is already the array of region objects
if (!Array.isArray(data.watchProviders)) return '';

let regionNode = data.watchProviders.find((r: any) => r.iso_3166_1 === region);
if (!regionNode) {
    regionNode = data.watchProviders.find((r: any) => r.iso_3166_1 === 'US');
}
if (!regionNode && data.watchProviders.length > 0) {
    regionNode = data.watchProviders[0];
}

if (!regionNode || !regionNode.flatrate?.length) return '';

// Only flatrate providers, unique by ID, limit to 6
const uniqueProviders: any[] = [];
const seenIds = new Set();
for (const p of regionNode.flatrate) {
    if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        uniqueProviders.push(p);
        if (uniqueProviders.length >= 6) break;
    }
}

if (!uniqueProviders.length) return '';

return `
    <div class="jc-more-info-stat-row">
        <div class="jc-more-info-stat-label">${JC.t!('seerr_modal_streaming')}</div>
        <div class="jc-more-info-providers-list">
            ${uniqueProviders.map((p: any) => `<img src="https://image.tmdb.org/t/p/w92${escapeHtml(p.logoPath)}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" />`).join('')}
        </div>
    </div>
`;
}

/**
 * Build collection card (Seerr-style)
 */
function buildCollectionCard(collection: any) {
if (!collection) return '';

const backdropUrl = collection.backdropPath
    ? `https://image.tmdb.org/t/p/w1440_and_h320_multi_faces/${collection.backdropPath}`
    : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect fill=%22%23374151%22 width=%22400%22 height=%22200%22/%3E%3C/svg%3E';

return `
    <div class="jc-collection-card">
        <div class="jc-collection-card-backdrop">
            <img src="${escapeHtml(backdropUrl)}" alt="${escapeHtml(collection.name)}" loading="lazy" />
            <div class="jc-collection-card-overlay"></div>
        </div>
        <div class="jc-collection-card-content">
            <div class="jc-collection-card-title">${escapeHtml(collection.name)}</div>
            <button class="jc-collection-card-button" data-collection-id="${escapeHtml(collection.id)}" data-collection-name="${escapeHtml(collection.name)}">
                ${JC.t!('seerr_btn_view_collection') || 'View'}
            </button>
        </div>
    </div>
`;
}

/**
 * Build keywords section
 */
function buildKeywordsSection(data: any) {
if (!data.keywords?.length) return '';

return `
    <div class="keywords-section">
        <h3>${JC.t!('seerr_modal_keywords') || 'Keywords'}</h3>
        <div class="keywords-grid">
            ${data.keywords.slice(0, 20).map((k: any) => `<span class="keyword">${escapeHtml(k.name)}</span>`).join('')}
        </div>
    </div>
`;
}

/**
 * Build crew section (director, writers, etc.)
 */
function buildCrewSection(data: any, mediaType: any) {
if (mediaType === 'tv' && data.createdBy?.length) {
    return `
        <div class="creators">
            <h4>${JC.t!('seerr_modal_created_by') || 'Created By'}</h4>
            <p>${data.createdBy.map((c: any) => escapeHtml(c.name)).join(', ')}</p>
        </div>
    `;
}

if (data.credits?.crew) {
    const director = data.credits.crew.find((c: any) => c.job === 'Director');
    const writers = data.credits.crew.filter((c: any) =>
        c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Story'
    ).slice(0, 3);

    let html = '';
    if (director) {
        html += `
            <div class="crew-item">
                <h4>${JC.t!('seerr_modal_director') || 'Director'}</h4>
                <p>${escapeHtml(director.name)}</p>
            </div>
        `;
    }
    if (writers.length) {
        html += `
            <div class="crew-item">
                <h4>${JC.t!('seerr_modal_writers') || 'Writers'}</h4>
                <p>${writers.map((w: any) => escapeHtml(w.name)).join(', ')}</p>
            </div>
        `;
    }
    return html ? `<div class="crew-section">${html}</div>` : '';
}

return '';
}

/**
 * Build trailers section
 */
function buildTrailersSection(data: any) {
if (!data.relatedVideos || !data.relatedVideos.length) return '';

const trailers = data.relatedVideos
    .filter((v: any) => v.type === 'Trailer' || v.type === 'Teaser')
    .slice(0, 6);

if (!trailers.length) return '';

return `
    <div class="trailers-section">
        <h3>${JC.t!('seerr_modal_trailers')}</h3>
        <div class="trailers-grid">
            ${trailers.map((trailer: any) => {
                const thumbnailUrl = trailer.site === 'YouTube'
                    ? `https://img.youtube.com/vi/${trailer.key}/mqdefault.jpg`
                    : '';
                const youtubeIcon = trailer.site === 'YouTube' ? `<img src="${assetUrl('icons/youtube.png')}" alt="YouTube" class="trailer-youtube-icon" />` : '';

                return `
                    <a is="emby-linkbutton" href="${escapeHtml(trailer.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(trailer.name)}" class="trailer-item">
                        <div class="trailer-thumbnail">
                            ${thumbnailUrl ? `<img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(trailer.name)}" />` : ''}
                            <div class="jc-modal-play-button">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            </div>
                            ${youtubeIcon}
                        </div>
                        <div class="trailer-info">
                            <div class="trailer-name">${escapeHtml(trailer.name)}</div>
                            <div class="trailer-type">${escapeHtml(trailer.type)}</div>
                        </div>
                    </a>
                `;
            }).join('')}
        </div>
    </div>
`;
}

/**
 * Build cast section (horizontal scrollable)
 */
function buildCastSection(data: any) {
if (!data.credits?.cast || !data.credits.cast.length) return '';

const cast = data.credits.cast.slice(0, 20);

return `
    <div class="cast-section">
        <h3>${JC.t!('seerr_modal_cast')}</h3>
        <div class="cast-scroll">
            ${cast.map((person: any) => {
                const imageUrl = person.profilePath
                    ? `https://image.tmdb.org/t/p/w185${person.profilePath}`
                    : '';

                return `
                    <div class="cast-member">
                        <div class="person-avatar">
                            ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(person.name)}" />` : buildPersonPlaceholder()}
                        </div>
                        <div class="person-name">${escapeHtml(person.name)}</div>
                        <div class="person-character">${escapeHtml(person.character || '')}</div>
                    </div>
                `;
            }).join('')}
        </div>
    </div>
`;
}

/**
 * Build person placeholder SVG
 */
function buildPersonPlaceholder() {
return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" fill="#2a2a2a"/>
        <circle cx="50" cy="40" r="15" fill="#555"/>
        <path d="M 25 75 Q 25 60, 50 60 Q 75 60, 75 75 L 75 100 L 25 100 Z" fill="#555"/>
    </svg>
`;
}
internal.buildModalContent = buildModalContent;
internal.buildRightPanel = buildRightPanel;
internal.buildStreamingProviders = buildStreamingProviders;
internal.buildCollectionCard = buildCollectionCard;
internal.buildKeywordsSection = buildKeywordsSection;
internal.buildCrewSection = buildCrewSection;
internal.buildTrailersSection = buildTrailersSection;
internal.buildCastSection = buildCastSection;
internal.buildPersonPlaceholder = buildPersonPlaceholder;
