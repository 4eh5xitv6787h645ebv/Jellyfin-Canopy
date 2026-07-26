#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const STATE_FILE = process.env.JC_E2E_MOCK_STATE || '/state/config.json';
const CERT_DIR = process.env.JC_E2E_MOCK_CERT_DIR || '/state/certs';
const MAINTAINERR_AUDIT_FILE = process.env.JC_E2E_MAINTAINERR_AUDIT
    || '/state/maintainerr-requests.json';
const SEERR_KEY = 'jc-e2e-seerr';
const TMDB_KEY = 'jc-e2e-tmdb';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MAINTAINERR_AUDIT_ROWS = 256;
const MAINTAINERR_SLOW_MS = 20_000;
const MAINTAINERR_SECRET_SENTINEL = 'UPSTREAM_SECRET_MUST_NOT_ESCAPE';
// Maintainerr 3.18 only SQL-pages the default/deleteSoonest shape. Every
// media-metadata sort hydrates the full collection before slicing.
const MAINTAINERR_SORT_FIELDS = new Set(['deleteSoonest']);
const MAINTAINERR_SORT_ORDERS = new Set(['asc', 'desc']);

const titles = new Map([
    [550, { title: 'Fight Club', year: 1999, certification: 'R', genres: ['Drama'], collection: 10 }],
    [603, { title: 'The Matrix', year: 1999, certification: 'R', genres: ['Action', 'Science Fiction'] }],
    [604, { title: 'The Matrix Reloaded', year: 2003, certification: 'R', genres: ['Action', 'Science Fiction'] }],
    [862, { title: 'Toy Story', year: 1995, certification: 'G', genres: ['Animation', 'Family'] }],
    [10331, { title: 'Night of the Living Dead', year: 1968, certification: 'R', genres: ['Horror'], keywords: ['zombie'] }],
    [10332, { title: 'Night of the Living Dead: Reanimated', year: 2009, certification: 'R', genres: ['Horror'], keywords: ['animation'] }],
    [10333, { title: 'Night of the Living Deb', year: 2015, certification: 'PG-13', genres: ['Comedy'], keywords: ['parody'] }],
    [10334, { title: 'Living Dead Documentary', year: 2018, certification: 'PG', genres: ['Documentary'], keywords: ['filmmaking'] }],
    [293660, { title: 'Deadpool', year: 2016, certification: 'R', genres: ['Action', 'Comedy'] }],
    [383498, { title: 'Deadpool 2', year: 2018, certification: 'R', genres: ['Action', 'Comedy'] }],
]);

const genreIds = new Map([
    ['Action', 28], ['Adventure', 12], ['Animation', 16], ['Comedy', 35],
    ['Documentary', 99], ['Drama', 18], ['Family', 10751], ['Horror', 27],
    ['Science Fiction', 878],
]);

let nextRequestId = 1;
/** @type {Array<Record<string, unknown>>} */
let requests = [];

function readFixtureState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (!Array.isArray(parsed.users) || parsed.users.length !== 2) {
            throw new Error('fixture state must contain exactly two users');
        }
        return parsed;
    } catch (error) {
        return { users: [], error: error instanceof Error ? error.message : String(error) };
    }
}

function json(response, status, value) {
    const body = Buffer.from(`${JSON.stringify(value)}\n`);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    response.end(body);
}

function text(response, status, value) {
    const body = Buffer.from(value);
    response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    response.end(body);
}

function typedText(response, status, value, contentType) {
    const body = Buffer.from(value);
    response.writeHead(status, {
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    response.end(body);
}

async function bodyJson(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) throw new Error('request body exceeds fixture cap');
        chunks.push(chunk);
    }
    if (length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function userById(id) {
    return readFixtureState().users.find(user => Number(user.id) === Number(id)) || null;
}

function requestedBy(request) {
    const id = request.headers['x-api-user'];
    return id ? userById(id) : null;
}

function title(id) {
    return titles.get(Number(id)) || {
        title: `Fixture Movie ${id}`,
        year: 2020,
        certification: 'PG',
        genres: ['Drama'],
    };
}

function releaseDates(certification) {
    return {
        results: [{
            iso_3166_1: 'US',
            release_dates: [{ certification, type: 3, release_date: '2020-01-01T00:00:00.000Z' }],
        }],
    };
}

function movieDetail(id) {
    const value = title(id);
    const idNumber = Number(id);
    const genreObjects = value.genres.map(name => ({ id: genreIds.get(name) || 18, name }));
    const mediaRequests = requests.filter(row => Number(row.media.tmdbId) === idNumber);
    return {
        id: idNumber,
        mediaType: 'movie',
        title: value.title,
        originalTitle: value.title,
        overview: `Hermetic E2E fixture for ${value.title}.`,
        releaseDate: `${value.year}-01-01`,
        posterPath: null,
        backdropPath: null,
        genreIds: genreObjects.map(genre => genre.id),
        genres: genreObjects,
        keywords: (value.keywords || []).map((name, index) => ({ id: 9000 + index, name })),
        releases: releaseDates(value.certification),
        releaseDates: releaseDates(value.certification),
        collection: value.collection ? { id: value.collection, name: 'JC Fixture Collection' } : null,
        belongs_to_collection: value.collection ? { id: value.collection, name: 'JC Fixture Collection' } : null,
        mediaInfo: {
            id: idNumber + 100000,
            status: 1,
            status4k: 1,
            requests: mediaRequests,
        },
    };
}

function searchResults(query) {
    const normalized = query.toLowerCase();
    if (normalized.includes('deadpool')) {
        return [movieDetail(293660), movieDetail(383498), {
            id: 4790510,
            mediaType: 'person',
            name: 'Deadpool Fixture Person',
            knownFor: [],
        }];
    }
    if (normalized.includes('night of the living dead')) {
        return [10331, 10332, 10333, 10334].map(movieDetail);
    }
    return [550, 603, 862].map(movieDetail);
}

function requestRow(mediaType, mediaId, owner) {
    const detail = movieDetail(mediaId);
    return {
        id: nextRequestId++,
        status: 1,
        type: mediaType,
        is4k: false,
        createdAt: new Date().toISOString(),
        requestedBy: {
            id: owner.id,
            displayName: owner.displayName,
            username: owner.username,
            avatar: null,
        },
        media: {
            id: Number(mediaId) + 100000,
            tmdbId: Number(mediaId),
            mediaType,
            title: detail.title,
            releaseDate: detail.releaseDate,
            posterPath: null,
            status: 1,
            status4k: 1,
            requests: [],
        },
    };
}

function page(results) {
    return {
        pageInfo: {
            // Seerr reports the requested one-based page even for an empty
            // result set. Returning page 0 makes completeness checks reject a
            // valid empty list after the last request is declined.
            page: 1,
            pages: 1,
            pageSize: results.length,
            results: results.length,
        },
        results,
    };
}

function requireSeerrKey(request, response) {
    if (request.headers['x-api-key'] !== SEERR_KEY) {
        json(response, 401, { message: 'invalid hermetic Seerr key' });
        return false;
    }
    return true;
}

async function handleSeerr(request, response) {
    const url = new URL(request.url, 'http://mock-integrations:5055');
    if (url.pathname === '/health') return json(response, 200, { ok: true });
    if (url.pathname === '/__e2e/state') {
        return json(response, 200, { fixture: readFixtureState(), requestCount: requests.length });
    }
    if (!requireSeerrKey(request, response)) return;

    if (url.pathname === '/api/v1/status') return json(response, 200, { version: '2.7.3-e2e', initialized: true });
    if (url.pathname === '/api/v1/settings/public') {
        return json(response, 200, { movie4kEnabled: true, series4kEnabled: true });
    }
    if (url.pathname === '/api/v1/settings/main') {
        return json(response, 200, { partialRequestsEnabled: true });
    }
    if (url.pathname === '/api/v1/user' && request.method === 'GET') {
        return json(response, 200, page(readFixtureState().users));
    }

    let match = url.pathname.match(/^\/api\/v1\/user\/(\d+)$/);
    if (match && request.method === 'GET') {
        const user = userById(match[1]);
        return user ? json(response, 200, user) : json(response, 404, { message: 'user not found' });
    }
    match = url.pathname.match(/^\/api\/v1\/user\/(\d+)\/quota$/);
    if (match && request.method === 'GET') {
        return json(response, 200, {
            movie: { limit: 10, used: 0, remaining: 10, restricted: false },
            tv: { limit: 10, used: 0, remaining: 10, restricted: false },
        });
    }
    match = url.pathname.match(/^\/api\/v1\/user\/(\d+)\/(requests|watchlist)$/);
    if (match && request.method === 'GET') {
        return json(response, 200, page(requests.filter(row => Number(row.requestedBy.id) === Number(match[1]))));
    }

    if (url.pathname === '/api/v1/search' && request.method === 'GET') {
        return json(response, 200, page(searchResults(url.searchParams.get('query') || '')));
    }
    if (url.pathname === '/api/v1/search/keyword') {
        return json(response, 200, { results: [{ id: 1, name: url.searchParams.get('query') || 'fixture' }] });
    }
    if (url.pathname === '/api/v1/genres/movie') {
        return json(response, 200, [...genreIds].map(([name, id]) => ({ id, name })));
    }
    if (url.pathname === '/api/v1/genres/tv') {
        return json(response, 200, [{ id: 18, name: 'Drama' }, { id: 35, name: 'Comedy' }]);
    }
    if (url.pathname.startsWith('/api/v1/discover/')) {
        return json(response, 200, page([550, 603, 862].map(movieDetail)));
    }

    match = url.pathname.match(/^\/api\/v1\/movie\/(\d+)(?:\/(similar|recommendations|ratingscombined))?$/);
    if (match && request.method === 'GET') {
        return match[2]
            ? json(response, 200, page([603, 862].map(movieDetail)))
            : json(response, 200, movieDetail(match[1]));
    }
    match = url.pathname.match(/^\/api\/v1\/collection\/(\d+)$/);
    if (match && request.method === 'GET') {
        return json(response, 200, {
            id: Number(match[1]),
            name: 'JC Fixture Collection',
            parts: [
                { ...movieDetail(550), mediaInfo: { status: 5 } },
                {
                    ...movieDetail(603),
                    title: 'The Extraordinary Matrix Collection Chronicle With SupercalifragilisticexpialidociousRevisited',
                    mediaInfo: { status: 1 },
                },
                { ...movieDetail(862), mediaInfo: { status: 1 } },
            ],
        });
    }

    if (url.pathname === '/api/v1/request' && request.method === 'POST') {
        const owner = requestedBy(request);
        if (!owner) return json(response, 400, { message: 'missing or unknown x-api-user fixture identity' });
        const body = await bodyJson(request);
        const mediaId = Number(body.mediaId);
        const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
        if (!Number.isInteger(mediaId) || mediaId <= 0) return json(response, 400, { message: 'invalid media id' });
        let row = requests.find(existing => Number(existing.media.tmdbId) === mediaId
            && Number(existing.requestedBy.id) === Number(owner.id));
        if (!row) {
            row = requestRow(mediaType, mediaId, owner);
            requests.push(row);
        }
        return json(response, 201, row);
    }
    if (url.pathname === '/api/v1/request' && request.method === 'GET') {
        const requestedById = url.searchParams.get('requestedBy');
        const visible = requestedById
            ? requests.filter(row => Number(row.requestedBy.id) === Number(requestedById))
            : requests;
        return json(response, 200, page(visible));
    }
    match = url.pathname.match(/^\/api\/v1\/request\/(\d+)\/(approve|decline)$/);
    if (match && request.method === 'POST') {
        const index = requests.findIndex(row => Number(row.id) === Number(match[1]));
        if (index < 0) return json(response, 404, { message: 'request not found' });
        const row = requests[index];
        row.status = match[2] === 'approve' ? 2 : 3;
        if (match[2] === 'decline') requests.splice(index, 1);
        return json(response, 200, row);
    }

    if (url.pathname === '/api/v1/issue' && request.method === 'POST') {
        return json(response, 201, { id: 1, status: 1 });
    }
    if (url.pathname === '/api/v1/issue' && request.method === 'GET') return json(response, 200, page([]));
    if (url.pathname.startsWith('/api/v1/service/')) return json(response, 200, []);

    return json(response, 404, { message: `unhandled hermetic Seerr route ${request.method} ${url.pathname}` });
}

async function handleTmdb(request, response) {
    const url = new URL(request.url, 'https://api.themoviedb.org');
    if (url.searchParams.get('api_key') !== TMDB_KEY) {
        return json(response, 401, { status_message: 'invalid hermetic TMDB key' });
    }
    if (url.pathname === '/3/configuration') return json(response, 200, { images: { secure_base_url: 'https://image.tmdb.org/t/p/' } });
    if (url.pathname === '/3/genre/movie/list') return json(response, 200, { genres: [...genreIds].map(([name, id]) => ({ id, name })) });
    if (url.pathname === '/3/genre/tv/list') return json(response, 200, { genres: [{ id: 18, name: 'Drama' }] });

    let match = url.pathname.match(/^\/3\/movie\/(\d+)\/release_dates$/);
    if (match) return json(response, 200, { id: Number(match[1]), ...releaseDates(title(match[1]).certification) });
    match = url.pathname.match(/^\/3\/movie\/(\d+)\/watch\/providers$/);
    if (match) return json(response, 200, { id: Number(match[1]), results: {} });
    match = url.pathname.match(/^\/3\/movie\/(\d+)\/keywords$/);
    if (match) return json(response, 200, { id: Number(match[1]), keywords: movieDetail(match[1]).keywords });
    match = url.pathname.match(/^\/3\/movie\/(\d+)$/);
    if (match) {
        const detail = movieDetail(match[1]);
        return json(response, 200, {
            ...detail,
            release_date: detail.releaseDate,
            release_dates: detail.releaseDates,
        });
    }
    if (url.pathname.startsWith('/3/search/')) return json(response, 200, page(searchResults(url.searchParams.get('query') || '')));
    return json(response, 404, { status_message: `unhandled hermetic TMDB route ${request.method} ${url.pathname}` });
}

async function handleRadarr(request, response) {
    const url = new URL(request.url, 'http://mock-integrations:7878');
    if (request.headers['x-api-key'] !== 'jc-e2e-arr') return json(response, 401, { message: 'invalid hermetic arr key' });
    if (url.pathname === '/api/v3/system/status' && request.method === 'GET') {
        return json(response, 200, {
            appName: 'Radarr',
            instanceName: 'E2E Radarr',
            version: '5.0.0',
        });
    }
    if (url.pathname === '/api/v3/movie' && request.method === 'GET') return json(response, 200, []);
    if (url.pathname === '/api/v3/queue') return json(response, 200, { page: 1, pageSize: 0, totalRecords: 0, records: [] });
    if (url.pathname === '/api/v3/qualityprofile') return json(response, 200, [{ id: 1, name: 'Any' }]);
    if (url.pathname === '/api/v3/rootfolder') return json(response, 200, [{ id: 1, path: '/movies', freeSpace: 1000000000 }]);
    if (url.pathname === '/api/v3/tag') return json(response, 200, []);
    return json(response, 404, { message: `unhandled hermetic Radarr route ${request.method} ${url.pathname}` });
}

function maintainerrFixture() {
    const value = readFixtureState().maintainerr;
    if (!value || typeof value !== 'object') {
        return {
            mode: 'happy',
            jellyfinMachineId: 'jc-e2e-machine-id-not-seeded',
            itemStatuses: {},
        };
    }
    return {
        mode: typeof value.mode === 'string' ? value.mode : 'happy',
        jellyfinMachineId: typeof value.jellyfinMachineId === 'string'
            ? value.jellyfinMachineId
            : 'jc-e2e-machine-id-not-seeded',
        itemStatuses: value.itemStatuses && typeof value.itemStatuses === 'object'
            ? value.itemStatuses
            : {},
    };
}

function maintainerrAuditPath(pathname) {
    const exact = new Set([
        '/api/health/ready',
        '/api/app/status',
        '/api/media-server/type',
        '/api/media-server',
        '/api/storage-metrics',
        '/api/overlays/status',
        '/api/rules/count',
        '/api/rules/execute/status',
        '/api/collections',
    ]);
    if (exact.has(pathname)) return pathname;
    if (/^\/api\/collections\/media\/[1-9]\d*\/content\/[1-9]\d*$/.test(pathname)) {
        return '/api/collections/media/:collectionId/content/:page';
    }
    if (/^\/api\/media-server\/meta\/[0-9a-fA-F-]+\/maintainerr-status$/.test(pathname)) {
        return '/api/media-server/meta/:itemId/maintainerr-status';
    }
    return '<rejected>';
}

function maintainerrAuditQuery(url) {
    const safe = {};
    for (const key of ['size', 'sort', 'sortOrder']) {
        const values = url.searchParams.getAll(key);
        if (values.length === 1) safe[key] = values[0];
    }
    return safe;
}

function appendMaintainerrAudit(row) {
    let current = { schemaVersion: 1, requests: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(MAINTAINERR_AUDIT_FILE, 'utf8'));
        if (parsed?.schemaVersion === 1 && Array.isArray(parsed.requests)) current = parsed;
    } catch {
        // A missing audit file is the normal initial state for every shard.
    }
    const lastSequence = current.requests.reduce(
        (maximum, entry) => Math.max(maximum, Number(entry?.sequence) || 0),
        0
    );
    const requestsForAudit = [...current.requests, {
        schemaVersion: 1,
        sequence: lastSequence + 1,
        ...row,
    }].slice(-MAX_MAINTAINERR_AUDIT_ROWS);
    const next = `${JSON.stringify({ schemaVersion: 1, requests: requestsForAudit }, null, 2)}\n`;
    const temporary = `${MAINTAINERR_AUDIT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, next, { mode: 0o600 });
    fs.renameSync(temporary, MAINTAINERR_AUDIT_FILE);
}

function trackMaintainerrRequest(request, response, url, mode) {
    let recorded = false;
    const record = aborted => {
        if (recorded) return;
        recorded = true;
        appendMaintainerrAudit({
            method: request.method || '',
            path: maintainerrAuditPath(url.pathname),
            query: maintainerrAuditQuery(url),
            status: response.headersSent ? response.statusCode : 0,
            mode,
            aborted,
            credentialHeadersPresent: Object.keys(request.headers)
                .some(name => /authorization|api[-_]?key|token|cookie|credential/i.test(name)),
        });
    };
    response.once('finish', () => record(false));
    response.once('close', () => record(!response.writableEnded));
}

function hasOnlyQuery(url, allowed) {
    for (const key of url.searchParams.keys()) {
        if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return false;
    }
    return true;
}

function validCollectionContentQuery(url) {
    if (!hasOnlyQuery(url, new Set(['size', 'sort', 'sortOrder']))) return false;
    const sizeText = url.searchParams.get('size');
    if (sizeText !== null && (!/^[1-9]\d?$/.test(sizeText) || Number(sizeText) > 50)) return false;
    const sort = url.searchParams.get('sort');
    if (sort !== null && !MAINTAINERR_SORT_FIELDS.has(sort)) return false;
    const sortOrder = url.searchParams.get('sortOrder');
    return sortOrder === null || MAINTAINERR_SORT_ORDERS.has(sortOrder);
}

function maintainerrCollections(empty) {
    if (empty) return [];
    return [
        {
            id: 11,
            mediaServerId: 'collection-safe-id-11',
            mediaServerType: 'jellyfin',
            libraryId: 'fixture-library',
            title: 'Weekend cleanup',
            description: 'Items become eligible after the retention window.',
            isActive: true,
            arrAction: 1,
            deleteAfterDays: 30,
            manualCollection: false,
            type: 'movie',
            handledMediaAmount: 7,
            lastDurationInSeconds: 12,
            handledMediaSizeBytes: 2147483648,
            totalSizeBytes: 4294967296,
            mediaCount: 26,
            media: [],
            ruleGroup: {
                notificationAgent: {
                    options: { webhookUrl: `https://${MAINTAINERR_SECRET_SENTINEL}.invalid/hook` },
                },
                ruleJson: MAINTAINERR_SECRET_SENTINEL,
                arrDiskPath: `/mnt/${MAINTAINERR_SECRET_SENTINEL}`,
            },
        },
        {
            id: 12,
            mediaServerId: 'collection-safe-id-12',
            mediaServerType: 'jellyfin',
            libraryId: 'fixture-library',
            title: 'Manual keep list',
            description: null,
            isActive: false,
            arrAction: 0,
            deleteAfterDays: null,
            manualCollection: true,
            type: 'show',
            handledMediaAmount: 0,
            lastDurationInSeconds: 0,
            handledMediaSizeBytes: 0,
            totalSizeBytes: 1073741824,
            mediaCount: 1,
            media: [],
        },
    ];
}

function maintainerrStorageMetrics(empty) {
    const zero = empty ? 0 : 1;
    return {
        generatedAt: '2026-07-26T00:00:00.000Z',
        totals: {
            freeSpace: 1000000000,
            totalSpace: 2000000000,
            usedSpace: 1000000000,
            mountCount: 1,
            accurateMountCount: 1,
            accurateTotalSpace: true,
        },
        collectionSummary: {
            reclaimableCount: zero,
            activeSizeBytes: empty ? 0 : 4294967296,
            reclaimableSizedCount: zero,
            inactiveCount: zero,
            totalCollectionCount: empty ? 0 : 2,
            movieSizeBytes: empty ? 0 : 4294967296,
            showSizeBytes: 0,
            seasonSizeBytes: 0,
            episodeSizeBytes: 0,
            reclaimableMovieCount: zero,
            reclaimableShowCount: 0,
            reclaimableSeasonCount: 0,
            reclaimableEpisodeCount: 0,
            reclaimableUsingFallback: false,
        },
        cleanupTotals: {
            itemsHandled: empty ? 0 : 7,
            moviesHandled: empty ? 0 : 7,
            showsHandled: 0,
            seasonsHandled: 0,
            episodesHandled: 0,
            bytesHandled: empty ? 0 : 2147483648,
            movieBytesHandled: empty ? 0 : 2147483648,
            showBytesHandled: 0,
            seasonBytesHandled: 0,
            episodeBytesHandled: 0,
        },
        mounts: [{
            path: `/mnt/${MAINTAINERR_SECRET_SENTINEL}`,
            label: MAINTAINERR_SECRET_SENTINEL,
            freeSpace: 1,
            totalSpace: 2,
        }],
        instances: [{
            id: 99,
            name: MAINTAINERR_SECRET_SENTINEL,
            type: 'radarr',
            ok: true,
            error: null,
            mountCount: 1,
        }],
        mediaServer: {
            configured: true,
            serverType: 'jellyfin',
            serverName: MAINTAINERR_SECRET_SENTINEL,
            reachable: true,
            error: null,
            libraries: [{
                id: MAINTAINERR_SECRET_SENTINEL,
                title: MAINTAINERR_SECRET_SENTINEL,
                type: 'movie',
                itemCount: 1,
                sizeBytes: 1,
            }],
            totalItemCount: 1,
        },
        topCollections: [{
            id: 99,
            title: MAINTAINERR_SECRET_SENTINEL,
            type: 'movie',
            mediaCount: 1,
            totalSizeBytes: 1,
            isActive: true,
        }],
        unknownSecret: MAINTAINERR_SECRET_SENTINEL,
    };
}

function maintainerrCollectionContent(collectionId, pageNumber, empty) {
    if (empty) return { totalSize: 0, items: [] };
    if (pageNumber > 2) return { totalSize: 26, items: [] };
    if (pageNumber === 2) {
        return {
            totalSize: 26,
            items: [{
                id: 126,
                collectionId,
                mediaServerId: 'fixture-media-26',
                addDate: '2026-07-26T00:00:00.000Z',
                isManual: false,
                includedByRule: true,
                sizeBytes: 536870912,
                mediaData: {
                    id: 'fixture-media-26',
                    title: 'Gamma Finale',
                    guid: 'fixture-guid-26',
                    type: 'movie',
                    addedAt: '2026-07-03T00:00:00.000Z',
                    providerIds: {},
                    mediaSources: [{ id: 'source-26', duration: 1800, sizeBytes: 536870912 }],
                },
            }],
        };
    }
    return {
        // Keep the fixture body compact while retaining a real second page.
        // The Canopy route is responsible for bounding each requested page;
        // the total is what drives the browser's pagination controls.
        totalSize: 26,
        items: [
            {
                id: 101,
                collectionId,
                mediaServerId: 'fixture-media-1',
                addDate: '2026-07-01T00:00:00.000Z',
                isManual: false,
                includedByRule: true,
                sizeBytes: 2147483648,
                mediaData: {
                    id: 'fixture-media-1',
                    title: 'Alpha Adventure',
                    guid: 'fixture-guid-1',
                    type: 'movie',
                    addedAt: '2026-06-01T00:00:00.000Z',
                    providerIds: {},
                    mediaSources: [{ id: 'source-1', duration: 3600, sizeBytes: 2147483648 }],
                    library: { id: MAINTAINERR_SECRET_SENTINEL, title: MAINTAINERR_SECRET_SENTINEL },
                    filePath: `/media/${MAINTAINERR_SECRET_SENTINEL}`,
                },
            },
            {
                id: 102,
                collectionId,
                mediaServerId: 'fixture-media-2',
                addDate: '2026-07-02T00:00:00.000Z',
                isManual: true,
                includedByRule: false,
                sizeBytes: 1073741824,
                mediaData: {
                    id: 'fixture-media-2',
                    title: 'Beta Mystery',
                    guid: 'fixture-guid-2',
                    type: 'movie',
                    addedAt: '2026-06-02T00:00:00.000Z',
                    providerIds: {},
                    mediaSources: [{ id: 'source-2', duration: 3600, sizeBytes: 1073741824 }],
                    library: { id: MAINTAINERR_SECRET_SENTINEL, title: MAINTAINERR_SECRET_SENTINEL },
                },
            },
        ],
    };
}

async function applyMaintainerrMode(request, response, mode, routeKind) {
    if (mode === 'slow') {
        await new Promise(resolve => {
            const timer = setTimeout(resolve, MAINTAINERR_SLOW_MS);
            const cancel = () => {
                clearTimeout(timer);
                resolve();
            };
            request.once('aborted', cancel);
            response.once('close', () => {
                if (!response.writableEnded) cancel();
            });
        });
        if (request.aborted || response.destroyed) return false;
    }
    if (mode === 'redirect') {
        response.writeHead(302, {
            location: '/api/health/ready',
            'cache-control': 'no-store',
        });
        response.end();
        return false;
    }
    if (mode === 'malformed') {
        typedText(response, 200, '{"status":', 'application/json; charset=utf-8');
        return false;
    }
    if (mode === 'oversized') {
        json(response, 200, {
            status: 1,
            version: '3.18.0-e2e',
            padding: 'x'.repeat(routeKind === 'collections' ? (2 * 1024 * 1024) + 1024 : 70 * 1024),
        });
        return false;
    }
    return true;
}

async function handleMaintainerr(request, response) {
    const url = new URL(request.url, 'http://mock-integrations:6246');
    const fixture = maintainerrFixture();
    const mode = fixture.mode;
    trackMaintainerrRequest(request, response, url, mode);

    if (request.method !== 'GET') {
        return json(response, 405, { message: 'hermetic Maintainerr fixture is read-only' });
    }

    let match;
    let routeKind = 'small';
    if (url.pathname === '/api/collections'
        || url.pathname === '/api/storage-metrics'
        || /^\/api\/collections\/media\/[1-9]\d*\/content\/[1-9]\d*$/.test(url.pathname)) {
        routeKind = 'collections';
    }
    const isContent = /^\/api\/collections\/media\/[1-9]\d*\/content\/[1-9]\d*$/.test(url.pathname);
    if (isContent ? !validCollectionContentQuery(url) : !hasOnlyQuery(url, new Set())) {
        return json(response, 400, { message: 'unexpected hermetic Maintainerr query' });
    }

    const allowedPath = maintainerrAuditPath(url.pathname) !== '<rejected>';
    if (!allowedPath) {
        return json(response, 404, { message: 'unhandled hermetic Maintainerr route' });
    }

    const optionalUnsupported = new Set([
        '/api/storage-metrics',
        '/api/overlays/status',
        '/api/rules/count',
        '/api/rules/execute/status',
    ]);
    if (mode === 'unsupported'
        && (optionalUnsupported.has(url.pathname)
            || url.pathname.startsWith('/api/collections/media/'))) {
        return json(response, 404, { message: 'capability unavailable in hermetic fixture' });
    }

    if (!await applyMaintainerrMode(request, response, mode, routeKind)) return;
    const empty = mode === 'empty';

    if (url.pathname === '/api/health/ready') {
        return json(response, 200, {
            status: 'ok',
            uptimeSeconds: 3600,
            database: 'ok',
            timestamp: '2026-07-26T00:00:00.000Z',
        });
    }
    if (url.pathname === '/api/app/status') {
        return typedText(response, 200, JSON.stringify({
            status: 1,
            version: '3.18.0',
            commitTag: 'latest-e2e000',
            updateAvailable: false,
        }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/media-server/type') return json(response, 200, { type: 'jellyfin' });
    if (url.pathname === '/api/media-server') {
        return json(response, 200, {
            machineId: mode === 'mismatch' ? 'different-jellyfin-machine-id' : fixture.jellyfinMachineId,
            version: '10.11.0',
            name: MAINTAINERR_SECRET_SENTINEL,
            platform: 'linux',
            url: `http://${MAINTAINERR_SECRET_SENTINEL}.invalid`,
        });
    }
    if (url.pathname === '/api/storage-metrics') return json(response, 200, maintainerrStorageMetrics(empty));
    if (url.pathname === '/api/overlays/status') {
        return json(response, 200, { status: 'idle', lastRun: null, lastResult: null });
    }
    if (url.pathname === '/api/rules/count') return json(response, 200, empty ? 0 : 3);
    if (url.pathname === '/api/rules/execute/status') {
        return json(response, 200, {
            processingQueue: false,
            executingRuleGroupId: null,
            pendingRuleGroupIds: empty ? [] : [91, 92],
            queue: empty ? [] : [93],
            secretQueueMetadata: MAINTAINERR_SECRET_SENTINEL,
        });
    }
    if (url.pathname === '/api/collections') return json(response, 200, maintainerrCollections(empty));

    match = url.pathname.match(/^\/api\/collections\/media\/([1-9]\d*)\/content\/([1-9]\d*)$/);
    if (match) {
        return json(
            response,
            200,
            maintainerrCollectionContent(Number(match[1]), Number(match[2]), empty)
        );
    }

    match = url.pathname.match(/^\/api\/media-server\/meta\/([0-9a-fA-F-]+)\/maintainerr-status$/);
    if (match) {
        const configured = fixture.itemStatuses[match[1]];
        return json(response, 200, empty ? { excludedFrom: [], manuallyAddedTo: [] } : configured || {
            excludedFrom: [{
                label: 'Protected by retention policy',
                targetPath: '/collections/11',
            }],
            manuallyAddedTo: [{
                label: 'Manually managed',
                targetPath: '/collections/12',
            }],
            unknownSecret: MAINTAINERR_SECRET_SENTINEL,
        });
    }

    return json(response, 404, { message: 'unhandled hermetic Maintainerr route' });
}

function serve(handler, request, response) {
    Promise.resolve(handler(request, response)).catch(error => {
        if (!response.headersSent) json(response, 500, { message: error instanceof Error ? error.message : String(error) });
        else response.destroy(error instanceof Error ? error : undefined);
    });
}

const seerrServer = http.createServer((request, response) => serve(handleSeerr, request, response));
const radarrServer = http.createServer((request, response) => serve(handleRadarr, request, response));
const maintainerrServer = http.createServer((request, response) => serve(handleMaintainerr, request, response));
const tmdbServer = https.createServer({
    key: fs.readFileSync(`${CERT_DIR}/server-key.pem`),
    cert: fs.readFileSync(`${CERT_DIR}/server.pem`),
}, (request, response) => serve(handleTmdb, request, response));

seerrServer.listen(5055, '0.0.0.0');
radarrServer.listen(7878, '0.0.0.0');
maintainerrServer.listen(6246, '0.0.0.0');
tmdbServer.listen(443, '0.0.0.0');

function shutdown() {
    for (const server of [seerrServer, radarrServer, maintainerrServer, tmdbServer]) server.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
