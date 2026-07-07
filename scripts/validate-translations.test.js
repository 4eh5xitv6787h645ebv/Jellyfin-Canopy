#!/usr/bin/env node

/**
 * Unit tests for the hardened translation validator.
 *
 * Uses node:test + node:assert (matches the scripts' CommonJS world — no
 * vitest/TS-interop friction). Run with `npm run test:scripts` or directly with
 * `node scripts/validate-translations.test.js`.
 *
 * Covers the three hardening behaviors:
 *   - icon-token / curly placeholder parity is enforced (a dropped or malformed
 *     token is a missing-placeholder error);
 *   - empty/whitespace values are ERRORS (were warnings);
 *   - non-string values are reported as errors instead of crashing the run.
 * Plus a class guard over the real shipped locales and a presence check for the
 * localized nav/calendar labels.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractPlaceholders, validateEntries } = require('./validate-translations.js');
// The require is side-effect-free: main() is guarded by require.main === module.

const LOCALES_DIR = path.join(__dirname, '../Jellyfin.Plugin.JellyfinElevate/js/locales');

// --- MB-5: icon-token + curly placeholder parity ---
test('extractPlaceholders captures well-formed icon tokens', () => {
    assert.deepStrictEqual(extractPlaceholders('{{icon:fastForward}} Go'), ['{{icon:fastForward}}']);
});

test('extractPlaceholders ignores a malformed single-brace icon token', () => {
    assert.deepStrictEqual(extractPlaceholders('{{icon:fastForward} Go'), []);
});

test('extractPlaceholders still captures simple params, no icon false-positive', () => {
    assert.deepStrictEqual(extractPlaceholders('Speed {speed}x, {count} items'), ['{count}', '{speed}']);
});

test('MB-5 malformed icon token is a missing-placeholder error', () => {
    const { errors } = validateEntries({ k: '{{icon:fastForward}} x' }, { k: '{{icon:fastForward} x' });
    assert.ok(errors.some(e => /missing placeholders/i.test(e)), errors.join(' | '));
});

test('MB-5 dropped {curly} param is a missing-placeholder error', () => {
    const { errors } = validateEntries({ k: 'Hi {name}' }, { k: 'Hola' });
    assert.ok(errors.some(e => /missing placeholders/i.test(e)), errors.join(' | '));
});

// --- MB-6: empty values are errors, not warnings ---
test('MB-6 empty/whitespace value is an ERROR', () => {
    const { errors } = validateEntries({ k: 'Hello' }, { k: '   ' });
    assert.ok(errors.some(e => /empty/i.test(e)), errors.join(' | '));
});

// --- MB-7: non-string values don't crash ---
test('MB-7 non-string value yields a clean error, no throw', () => {
    let res;
    assert.doesNotThrow(() => { res = validateEntries({ k: 'Hello' }, { k: { nested: true } }); });
    assert.ok(res.errors.some(e => /non-string/i.test(e)), res.errors.join(' | '));
});

// --- A clean locale passes ---
test('a clean matching locale produces no errors', () => {
    const base = { greeting: 'Hello', speed: 'Speed {speed}x', icon: '{{icon:fastForward}} Go' };
    const clean = { greeting: 'Hola', speed: 'Velocidad {speed}x', icon: '{{icon:fastForward}} Ir' };
    assert.deepStrictEqual(validateEntries(base, clean).errors, []);
});

// --- Class guard over the REAL shipped locales ---
test('all shipped locales validate clean against en.json', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const f of fs.readdirSync(LOCALES_DIR).filter(x => x.endsWith('.json') && x !== 'en.json')) {
        const t = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'));
        const { errors } = validateEntries(en, t);
        assert.deepStrictEqual(errors, [], `${f}: ${errors.join(' | ')}`);
    }
});

// --- Presence of the localized nav/calendar labels ---
test('en.json defines the localized nav/calendar labels', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const k of ['bookmarks_library_title', 'calendar_prev', 'calendar_next']) {
        assert.ok(typeof en[k] === 'string' && en[k].trim() !== '', `missing ${k}`);
    }
});
