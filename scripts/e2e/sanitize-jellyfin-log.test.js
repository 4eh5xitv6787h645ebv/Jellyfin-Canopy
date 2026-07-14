#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
    REDACTED,
    sanitizeJellyfinLog,
} = require('./sanitize-jellyfin-log');

const SCRIPT = path.join(__dirname, 'sanitize-jellyfin-log.js');

test('redacts the Jellyfin 12 RC2 logout token and preserves diagnostic context', () => {
    const input = '[2026-07-14 12:34:56.789 +00:00] [INF] [42] '
        + 'Emby.Server.Implementations.Session.SessionManager: '
        + 'Logging out access token "jf-test-logout-secret"\n'
        + '[2026-07-14 12:34:56.790 +00:00] [ERR] POST /Sessions/Logout returned 500\n';

    assert.equal(
        sanitizeJellyfinLog(input),
        '[2026-07-14 12:34:56.789 +00:00] [INF] [42] '
            + 'Emby.Server.Implementations.Session.SessionManager: '
            + `Logging out access token "${REDACTED}"\n`
            + '[2026-07-14 12:34:56.790 +00:00] [ERR] POST /Sessions/Logout returned 500\n'
    );
});

test('redacts Jellyfin authorization schemes while keeping their names', () => {
    const input = [
        'Authorization: Bearer bearer-test-secret',
        'authorization=Basic basic-test-secret==',
        'X-Emby-Authorization: Token token-scheme-secret',
        'X-MediaBrowser-Authorization: ApiKey api-key-scheme-secret',
        'Authorization: opaque-test-secret',
    ].join('\n');

    assert.equal(sanitizeJellyfinLog(input), [
        `Authorization: Bearer ${REDACTED}`,
        `authorization=Basic ${REDACTED}`,
        `X-Emby-Authorization: Token ${REDACTED}`,
        `X-MediaBrowser-Authorization: ApiKey ${REDACTED}`,
        `Authorization: ${REDACTED}`,
    ].join('\n'));
});

test('redacts bracketed, array-wrapped, and quoted authorization credentials', () => {
    const input = [
        'Authorization: [Bearer bracket-secret];',
        'Authorization: Bearer "quoted-secret"',
        '{"Authorization":["Bearer array-secret"]}',
        'headers["Authorization"] = Basic accessor-secret',
    ].join('\n');
    const output = sanitizeJellyfinLog(input);

    assert.equal(output, [
        `Authorization: [Bearer ${REDACTED}];`,
        `Authorization: Bearer "${REDACTED}"`,
        `{"Authorization":["Bearer ${REDACTED}"]}`,
        `headers["Authorization"] = Basic ${REDACTED}`,
    ].join('\n'));
    for (const secret of [
        'bracket-secret',
        'quoted-secret',
        'array-secret',
        'accessor-secret',
    ]) {
        assert.doesNotMatch(output, new RegExp(secret));
    }
});

test('redacts MediaBrowser token fields but retains client and device evidence', () => {
    const input = 'Authorization: MediaBrowser Client="Jellyfin Web", '
        + 'Device="Chrome", DeviceId="e2e-device", Version="12.0.0", '
        + 'Token="media-browser-secret"';

    assert.equal(
        sanitizeJellyfinLog(input),
        'Authorization: MediaBrowser Client="Jellyfin Web", '
            + 'Device="Chrome", DeviceId="e2e-device", Version="12.0.0", '
            + `Token="${REDACTED}"`
    );
});

test('redacts token headers and JSON-serialized header values', () => {
    const input = 'X-MediaBrowser-Token: header-test-secret\n'
        + 'x-emby-token="legacy-header-secret"\n'
        + '{"Authorization":"MediaBrowser Token=\\"json-auth-secret\\", Client=\\"Canopy\\"",'
        + '"X-MediaBrowser-Token":"json-header-secret","apiKey":"json-api-secret"}\n';

    const output = sanitizeJellyfinLog(input);
    assert.equal(output, `X-MediaBrowser-Token: ${REDACTED}\n`
        + `x-emby-token="${REDACTED}"\n`
        + `{"Authorization":"MediaBrowser Token=\\"${REDACTED}\\", Client=\\"Canopy\\"",`
        + `"X-MediaBrowser-Token":"${REDACTED}","apiKey":"${REDACTED}"}\n`);
    for (const secret of [
        'header-test-secret',
        'legacy-header-secret',
        'json-auth-secret',
        'json-header-secret',
        'json-api-secret',
    ]) {
        assert.doesNotMatch(output, new RegExp(secret));
    }
});

test('redacts array token headers and service-prefixed API-key config fields', () => {
    const input = '{"X-MediaBrowser-Token":["array-header-secret"],'
        + '"SeerrApiKey":"seerr-secret","SonarrApiKey":"sonarr-secret",'
        + '"RadarrApiKey":"radarr-secret","TMDB_API_KEY":"tmdb-secret",'
        + '"service":"Seerr","attempt":2}\n'
        + 'config["CustomApiKey"] = "custom-service-secret"';
    const output = sanitizeJellyfinLog(input);

    assert.equal(output, `{"X-MediaBrowser-Token":["${REDACTED}"],`
        + `"SeerrApiKey":"${REDACTED}","SonarrApiKey":"${REDACTED}",`
        + `"RadarrApiKey":"${REDACTED}","TMDB_API_KEY":"${REDACTED}",`
        + '"service":"Seerr","attempt":2}\n'
        + `config["CustomApiKey"] = "${REDACTED}"`);
    for (const secret of [
        'array-header-secret',
        'seerr-secret',
        'sonarr-secret',
        'radarr-secret',
        'tmdb-secret',
        'custom-service-secret',
    ]) {
        assert.doesNotMatch(output, new RegExp(secret));
    }
    assert.match(output, /"service":"Seerr","attempt":2/);
});

test('redacts API-key and token query variants without hiding route context', () => {
    const input = 'GET /socket?api_key=query-api-secret&deviceId=e2e-device'
        + '&ApiKey=query-camel-secret&access_token=query-access-secret'
        + '&auth-token=query-auth-secret&token=query-token-secret'
        + '&api_key[]=query-array-secret#fragment HTTP/1.1';

    assert.equal(
        sanitizeJellyfinLog(input),
        `GET /socket?api_key=${REDACTED}&deviceId=e2e-device`
            + `&ApiKey=${REDACTED}&access_token=${REDACTED}`
            + `&auth-token=${REDACTED}&token=${REDACTED}`
            + `&api_key[]=${REDACTED}#fragment HTTP/1.1`
    );
});

test('leaves unrelated log text and line endings byte-for-byte unchanged', () => {
    const input = '[INF] Token bucket replenished\r\n'
        + '[DBG] API key authentication is disabled\r\n'
        + '[ERR] POST /Sessions/Logout returned 500\r\n';

    assert.equal(sanitizeJellyfinLog(input), input);
});

test('the transformation is idempotent', () => {
    const input = 'Logging out access token "repeat-secret"\n'
        + 'Authorization: MediaBrowser Token="repeat-media-secret", Client="Canopy"\n'
        + 'Authorization: [Bearer repeat-bracket-secret]\n'
        + '{"Authorization":["Bearer repeat-array-secret"],'
        + '"SeerrApiKey":"repeat-service-secret"}\n'
        + 'GET /Users/Me?ApiKey[]=repeat-query-secret';
    const once = sanitizeJellyfinLog(input);

    assert.equal(sanitizeJellyfinLog(once), once);
});

test('CLI reads stdin, writes only sanitized stdout, and exits successfully', () => {
    const input = 'compose-prefix | Logging out access token "cli-logout-secret"\n'
        + 'compose-prefix | GET /Sessions/Logout?api_key=cli-query-secret&attempt=2\n';
    const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        input,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'compose-prefix | '
        + `Logging out access token "${REDACTED}"\n`
        + `compose-prefix | GET /Sessions/Logout?api_key=${REDACTED}&attempt=2\n`);
    assert.doesNotMatch(result.stdout, /cli-(?:logout|query)-secret/);
});
