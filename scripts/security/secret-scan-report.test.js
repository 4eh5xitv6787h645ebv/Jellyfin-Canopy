#!/usr/bin/env node

/**
 * Unit tests for the secret-scan gate (BI-SEC-020). node:test + node:assert,
 * matching the scripts' CommonJS convention. Run with `npm run test:scripts`.
 *
 * Every acceptance case from the issue is exercised as a fast local test so the
 * gate's decision logic is pinned without a live TruffleHog run:
 *   clean, verified-finding, unverified-only, baselined, NEW-verified-not-covered,
 *   scanner-failure, malformed-output, non-numeric scanner exit; plus the
 *   never-leak-a-raw-secret invariant.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('./secret-scan-report.js');

const RAW_SECRET = 'AKIAIOSFODNN7EXAMPLEXYZ';

function findingLine({ detector = 'AWS', file = 'src/config.cs', line = 12, verified = false, raw = RAW_SECRET, rawV2 = undefined } = {}) {
    return JSON.stringify({
        DetectorName: detector,
        Verified: verified,
        Raw: raw,
        RawV2: rawV2 === undefined ? raw : rawV2,
        Redacted: String(raw).slice(0, 4) + '...REDACTED',
        SourceMetadata: { Data: { Git: { file, line, commit: 'deadbeef' } } },
    });
}

function evalJsonl(jsonl, { scannerExitCode = 0, baselineFps = [] } = {}) {
    const { findings, parseErrors } = S.parseResults(jsonl);
    const { set } = S.loadBaseline({ allow: baselineFps.map((fp) => ({ fingerprint: fp, reason: 't' })) });
    return S.evaluate({ findings, parseErrors, scannerExitCode, baseline: set, baselineMalformed: false });
}

test('clean scan (no findings, scanner ok) passes', () => {
    const r = evalJsonl('', { scannerExitCode: 0 });
    assert.strictEqual(r.shouldFail, false);
    assert.strictEqual(r.verifiedNew.length, 0);
});

test('a verified, non-baselined finding fails', () => {
    const r = evalJsonl(findingLine({ verified: true }), { scannerExitCode: 0 });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
    assert.match(r.reasons.join(' '), /verified secret/i);
});

test('unverified-only findings are reported but NON-blocking', () => {
    const r = evalJsonl(findingLine({ verified: false }), { scannerExitCode: 0 });
    assert.strictEqual(r.shouldFail, false);
    assert.strictEqual(r.unverifiedNew.length, 1);
});

test('a verified finding whose fingerprint is baselined passes', () => {
    const fp = S.fingerprint(JSON.parse(findingLine({ verified: true })));
    const r = evalJsonl(findingLine({ verified: true }), { scannerExitCode: 0, baselineFps: [fp] });
    assert.strictEqual(r.shouldFail, false);
    assert.strictEqual(r.baselinedHits.length, 1);
    assert.strictEqual(r.verifiedNew.length, 0);
});

test('a NEW verified finding is NOT accepted by a non-empty baseline (no silent accept)', () => {
    // Baseline covers a DIFFERENT secret; a brand-new verified secret must still fail.
    const otherFp = S.fingerprint(JSON.parse(findingLine({ verified: true, raw: 'OLDACCEPTEDSECRET1' })));
    const r = evalJsonl(findingLine({ verified: true, raw: 'BRANDNEWSECRET2' }), { scannerExitCode: 0, baselineFps: [otherFp] });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
});

test('a verified duplicate AFTER an unverified one still fails (monotonic verification)', () => {
    // BI-SEC-020-VERIFIED-DEDUPE: same fingerprint, unverified first then verified.
    const jsonl = findingLine({ verified: false }) + '\n' + findingLine({ verified: true });
    const r = evalJsonl(jsonl, { scannerExitCode: 0 });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
    assert.strictEqual(r.unverifiedNew.length, 0);
});

test('same Raw but different RawV2 are distinct findings (composite detector)', () => {
    // BI-SEC-020-INCOMPLETE-FINGERPRINT: only the RawV2 differs; the newer verified
    // secret must NOT be absorbed by a baseline entry for the older one.
    const oldFp = S.fingerprint(JSON.parse(findingLine({ verified: true, raw: 'SHARED', rawV2: 'OLDSECRET' })));
    const newLine = findingLine({ verified: true, raw: 'SHARED', rawV2: 'NEWSECRET' });
    assert.notStrictEqual(S.fingerprint(JSON.parse(newLine)), oldFp);
    const r = evalJsonl(newLine, { scannerExitCode: 0, baselineFps: [oldFp] });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
});

test('a verified finding with no raw identity is non-baselinable (always blocks)', () => {
    const line = JSON.stringify({ DetectorName: 'X', Verified: true, Raw: '', RawV2: '', SourceMetadata: { Data: { Git: { file: 'f', line: 1 } } } });
    const fp = S.fingerprint(JSON.parse(line));
    const r = evalJsonl(line, { scannerExitCode: 0, baselineFps: [fp] });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
});

test('a scanner crash (non-zero exit) fails visibly even with no findings', () => {
    const r = evalJsonl('', { scannerExitCode: 2 });
    assert.strictEqual(r.shouldFail, true);
    assert.match(r.reasons.join(' '), /tool failure|exited/i);
});

test('malformed scanner output fails closed', () => {
    const r = evalJsonl('{ not valid json\n' + findingLine({ verified: false }), { scannerExitCode: 0 });
    assert.strictEqual(r.shouldFail, true);
    assert.match(r.reasons.join(' '), /unparseable/i);
});

test('a baseline entry WITHOUT a reason does not allowlist (still fails)', () => {
    const fp = S.fingerprint(JSON.parse(findingLine({ verified: true })));
    // Same fingerprint, but the entry has no reason -> must NOT be honored.
    const { set } = S.loadBaseline({ allow: [{ fingerprint: fp }] });
    assert.strictEqual(set.has(fp), false);
    const { findings, parseErrors } = S.parseResults(findingLine({ verified: true }));
    const r = S.evaluate({ findings, parseErrors, scannerExitCode: 0, baseline: set, baselineMalformed: false });
    assert.strictEqual(r.shouldFail, true);
    assert.strictEqual(r.verifiedNew.length, 1);
});

test('a malformed baseline fails closed', () => {
    const { set, malformed } = S.loadBaseline({ allow: 'not-an-array' });
    const r = S.evaluate({ findings: [], parseErrors: 0, scannerExitCode: 0, baseline: set, baselineMalformed: malformed });
    assert.strictEqual(r.shouldFail, true);
});

test('fingerprint is stable and never contains the raw secret', () => {
    const f = JSON.parse(findingLine({ verified: true }));
    const fp1 = S.fingerprint(f);
    const fp2 = S.fingerprint(JSON.parse(findingLine({ verified: true })));
    assert.strictEqual(fp1, fp2);
    assert.ok(!fp1.includes(RAW_SECRET), 'fingerprint must not embed the raw secret');
});

test('report + summary never contain the raw secret', () => {
    const r = evalJsonl(findingLine({ verified: true }), { scannerExitCode: 0 });
    const summary = S.renderSummary(r);
    const report = JSON.stringify(S.buildReport(r));
    assert.ok(!summary.includes(RAW_SECRET), 'summary leaks the raw secret');
    assert.ok(!report.includes(RAW_SECRET), 'report leaks the raw secret');
});

// ── main() integration via temp files: exit code + written report ────────────

function withTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'je-secretscan-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('main() exits 1 on a verified finding and writes a leak-free report', () => {
    withTmp((dir) => {
        const results = path.join(dir, 'r.jsonl');
        const report = path.join(dir, 'report.json');
        const summary = path.join(dir, 'summary.md');
        fs.writeFileSync(results, findingLine({ verified: true }) + '\n');
        fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ allow: [] }));
        const code = S.main(['--results', results, '--scanner-exit', '0',
            '--baseline', path.join(dir, 'baseline.json'), '--report', report, '--summary', summary]);
        assert.strictEqual(code, 1);
        const written = fs.readFileSync(report, 'utf8');
        assert.match(written, /"result": "failed"/);
        assert.ok(!written.includes(RAW_SECRET));
        assert.ok(fs.readFileSync(summary, 'utf8').length > 0);
    });
});

test('the uploaded report (only artifact) stays leak-free when scanner output has Raw/RawV2', () => {
    // BI-SEC-020-RAW-ARTIFACT: only secret-scan-report.json is published; the raw
    // trufflehog JSONL (which carries Raw/RawV2) is kept runner-local. Prove the
    // published report never contains that material even when the input does.
    withTmp((dir) => {
        const results = path.join(dir, 'r.jsonl');
        const report = path.join(dir, 'secret-scan-report.json');
        fs.writeFileSync(results, findingLine({ verified: true }) + '\n' + findingLine({ verified: false, raw: 'ANOTHERRAWSECRET3' }) + '\n');
        S.main(['--results', results, '--scanner-exit', '0', '--report', report]);
        const written = fs.readFileSync(report, 'utf8');
        assert.ok(!written.includes(RAW_SECRET), 'published report leaks a verified raw secret');
        assert.ok(!written.includes('ANOTHERRAWSECRET3'), 'published report leaks an unverified raw secret');
    });
});

test('main() exits 0 on a clean scan', () => {
    withTmp((dir) => {
        const results = path.join(dir, 'r.jsonl');
        fs.writeFileSync(results, '');
        const code = S.main(['--results', results, '--scanner-exit', '0']);
        assert.strictEqual(code, 0);
    });
});

test('main() fails closed when the results path is a symlink', () => {
    // BI-SEC-020-UNTRUSTED-SCAN-OUTPUT: a planted symlink must not be honored.
    withTmp((dir) => {
        const real = path.join(dir, 'real.jsonl');
        fs.writeFileSync(real, ''); // empty => would otherwise be "clean"
        const link = path.join(dir, 'results.jsonl');
        fs.symlinkSync(real, link);
        const code = S.main(['--results', link, '--scanner-exit', '0']);
        assert.strictEqual(code, 1);
    });
});

test('main() fails closed when the results file is missing', () => {
    withTmp((dir) => {
        const code = S.main(['--results', path.join(dir, 'nope.jsonl'), '--scanner-exit', '0']);
        assert.strictEqual(code, 1);
    });
});

test('main() fails closed when scanner-exit is non-numeric', () => {
    withTmp((dir) => {
        const results = path.join(dir, 'r.jsonl');
        fs.writeFileSync(results, '');
        const code = S.main(['--results', results, '--scanner-exit', 'weird']);
        assert.strictEqual(code, 1);
    });
});
