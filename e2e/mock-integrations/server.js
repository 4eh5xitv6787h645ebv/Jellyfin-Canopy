#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const STATE_FILE = process.env.JC_E2E_MOCK_STATE || '/state/config.json';
const CERT_DIR = process.env.JC_E2E_MOCK_CERT_DIR || '/state/certs';
const SEERR_KEY = 'jc-e2e-seerr';
const TMDB_KEY = 'jc-e2e-tmdb';
const MAX_BODY_BYTES = 1024 * 1024;

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
                { ...movieDetail(603), mediaInfo: { status: 1 } },
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
    if (url.pathname === '/api/v3/movie' && request.method === 'GET') return json(response, 200, []);
    if (url.pathname === '/api/v3/queue') return json(response, 200, { page: 1, pageSize: 0, totalRecords: 0, records: [] });
    if (url.pathname === '/api/v3/qualityprofile') return json(response, 200, [{ id: 1, name: 'Any' }]);
    if (url.pathname === '/api/v3/rootfolder') return json(response, 200, [{ id: 1, path: '/movies', freeSpace: 1000000000 }]);
    if (url.pathname === '/api/v3/tag') return json(response, 200, []);
    return json(response, 404, { message: `unhandled hermetic Radarr route ${request.method} ${url.pathname}` });
}

function serve(handler, request, response) {
    Promise.resolve(handler(request, response)).catch(error => {
        if (!response.headersSent) json(response, 500, { message: error instanceof Error ? error.message : String(error) });
        else response.destroy(error instanceof Error ? error : undefined);
    });
}

const seerrServer = http.createServer((request, response) => serve(handleSeerr, request, response));
const radarrServer = http.createServer((request, response) => serve(handleRadarr, request, response));
const tmdbServer = https.createServer({
    key: fs.readFileSync(`${CERT_DIR}/server-key.pem`),
    cert: fs.readFileSync(`${CERT_DIR}/server.pem`),
}, (request, response) => serve(handleTmdb, request, response));

seerrServer.listen(5055, '0.0.0.0');
radarrServer.listen(7878, '0.0.0.0');
tmdbServer.listen(443, '0.0.0.0');

function shutdown() {
    for (const server of [seerrServer, radarrServer, tmdbServer]) server.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
