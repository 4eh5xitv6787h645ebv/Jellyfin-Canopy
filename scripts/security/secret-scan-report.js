#!/usr/bin/env node

/**
 * Secret-scan gate + reporter (BI-SEC-020).
 *
 * The Security Scan workflow runs the TruffleHog CLI over the full git history
 * with `--json` (all findings, verified AND unverified) and NO `--fail`, so its
 * exit code reflects only whether the scanner RAN — not whether it found
 * anything. This script is the single decision owner: it reads that JSONL, the
 * scanner's exit code, and a committed baseline/allowlist, then decides pass/fail
 * and writes a truthful, durable report (a GitHub step summary + a machine-
 * readable report JSON, both uploaded as an artifact — this private repo has no
 * GitHub Advanced Security, so a code-scanning SARIF surface is unavailable).
 *
 * Policy (fail CLOSED — any ambiguity blocks):
 *   - scanner exited non-zero (crash / tool failure)            -> FAIL
 *   - the results file is unparseable (malformed JSON lines)    -> FAIL
 *   - any non-baselined VERIFIED finding                        -> FAIL
 *   - non-baselined UNVERIFIED findings                         -> report, NON-blocking
 *   - clean (no non-baselined verified findings, scanner ok)    -> PASS
 *
 * A new verified secret whose fingerprint is not in the baseline still fails, so
 * the baseline can never silently accept a NEW secret.
 *
 * Never persists a raw secret: a finding's fingerprint is a one-way SHA-256 of
 * the raw match (with detector + path for readability); the report shows only the
 * detector, path/line, verified flag, and fingerprint — no secret material.
 *
 * Run via `npm run test:scripts` (unit) or as the workflow step:
 *   node scripts/security/secret-scan-report.js \
 *     --results trufflehog-results.jsonl --scanner-exit "$CODE" \
 *     --baseline .github/secret-scan-baseline.json \
 *     --summary "$GITHUB_STEP_SUMMARY" --report secret-scan-report.json
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

/** Parse TruffleHog JSONL. Blank lines are skipped; a non-blank line that is not
 * valid JSON is a parse error (the caller fails closed). Non-finding objects
 * (TruffleHog also emits log/info lines in some modes) are ignored: a finding is
 * an object carrying a DetectorName. */
function parseResults(text) {
    const findings = [];
    let parseErrors = 0;
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        } catch {
            parseErrors++;
            continue;
        }
        if (obj && typeof obj === 'object' && typeof obj.DetectorName === 'string') {
            findings.push(obj);
        }
    }
    return { findings, parseErrors };
}

/** Git source metadata (file/line) for a finding, tolerating shape drift. */
function gitMeta(finding) {
    const git = finding
        && finding.SourceMetadata
        && finding.SourceMetadata.Data
        && finding.SourceMetadata.Data.Git;
    if (!git || typeof git !== 'object') return { file: '', line: 0 };
    return { file: typeof git.file === 'string' ? git.file : '', line: Number(git.line) || 0 };
}

/** Stable, secret-free fingerprint: DetectorName + file + SHA-256(raw match).
 * The raw match is hashed, never stored. */
function fingerprint(finding) {
    const detector = (finding && finding.DetectorName) || 'unknown';
    const { file } = gitMeta(finding);
    const raw = (finding && (finding.Raw || finding.RawV2 || finding.Redacted)) || '';
    const hash = crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
    return `${detector}:${file}:${hash}`;
}

function isVerified(finding) {
    return finding && finding.Verified === true;
}

/** Baseline is { allow: [{ fingerprint, reason, ... }] }. Returns a Set of
 * allowlisted fingerprints. A malformed baseline yields an empty set AND is
 * flagged so the caller can fail closed rather than trust an unreadable
 * allowlist. */
function loadBaseline(baselineObj) {
    if (!baselineObj || typeof baselineObj !== 'object' || !Array.isArray(baselineObj.allow)) {
        return { set: new Set(), malformed: baselineObj != null };
    }
    const set = new Set();
    for (const entry of baselineObj.allow) {
        if (entry && typeof entry.fingerprint === 'string' && entry.fingerprint.trim() !== '') {
            set.add(entry.fingerprint.trim());
        }
    }
    return { set, malformed: false };
}

/**
 * Core decision. Returns a structured result; the caller renders + sets exit code.
 */
function evaluate({ findings, parseErrors, scannerExitCode, baseline, baselineMalformed }) {
    const seen = new Set();
    const verifiedNew = [];
    const unverifiedNew = [];
    const baselinedHits = [];

    for (const f of findings) {
        const fp = fingerprint(f);
        if (seen.has(fp)) continue; // de-dupe identical matches across commits
        seen.add(fp);
        const { file, line } = gitMeta(f);
        const item = { detector: f.DetectorName || 'unknown', file, line, verified: isVerified(f), fingerprint: fp };
        if (baseline.has(fp)) {
            baselinedHits.push(item);
        } else if (item.verified) {
            verifiedNew.push(item);
        } else {
            unverifiedNew.push(item);
        }
    }

    const reasons = [];
    if (scannerExitCode !== 0) reasons.push(`scanner exited with code ${scannerExitCode} (tool failure)`);
    if (parseErrors > 0) reasons.push(`${parseErrors} unparseable scanner output line(s)`);
    if (baselineMalformed) reasons.push('baseline allowlist is malformed');
    if (verifiedNew.length > 0) reasons.push(`${verifiedNew.length} verified secret finding(s) not in the baseline`);

    return {
        shouldFail: reasons.length > 0,
        reasons,
        verifiedNew,
        unverifiedNew,
        baselinedHits,
        scannerExitCode,
        parseErrors,
    };
}

function renderSummary(result) {
    const L = [];
    L.push('## 🔐 Secret scan');
    L.push('');
    if (result.shouldFail) {
        L.push('**Result: ❌ FAILED**');
        L.push('');
        for (const r of result.reasons) L.push(`- ${r}`);
    } else {
        L.push('**Result: ✅ passed**');
    }
    L.push('');
    L.push(`- Verified (new): **${result.verifiedNew.length}**`);
    L.push(`- Unverified (new, non-blocking): **${result.unverifiedNew.length}**`);
    L.push(`- Baselined (allowlisted): **${result.baselinedHits.length}**`);
    const list = (title, items) => {
        if (items.length === 0) return;
        L.push('');
        L.push(`### ${title}`);
        for (const i of items) {
            L.push(`- \`${i.detector}\` at \`${i.file || '(no path)'}\`${i.line ? `:${i.line}` : ''} — fingerprint \`${i.fingerprint}\``);
        }
    };
    list('Verified secrets (blocking)', result.verifiedNew);
    list('Unverified findings (review; non-blocking)', result.unverifiedNew);
    L.push('');
    L.push('_Fingerprints are one-way hashes; no secret material is shown. To accept a finding, add its fingerprint (with a reason) to `.github/secret-scan-baseline.json`._');
    return L.join('\n') + '\n';
}

function buildReport(result) {
    return {
        result: result.shouldFail ? 'failed' : 'passed',
        reasons: result.reasons,
        scannerExitCode: result.scannerExitCode,
        parseErrors: result.parseErrors,
        counts: {
            verifiedNew: result.verifiedNew.length,
            unverifiedNew: result.unverifiedNew.length,
            baselined: result.baselinedHits.length,
        },
        // Redacted-by-construction: fingerprints only, never raw/redacted secrets.
        verifiedNew: result.verifiedNew,
        unverifiedNew: result.unverifiedNew,
        baselinedHits: result.baselinedHits,
    };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    }
    return args;
}

function readFileSafe(path) {
    try {
        return { text: fs.readFileSync(path, 'utf8'), missing: false };
    } catch {
        return { text: '', missing: true };
    }
}

function main(argv) {
    const args = parseArgs(argv);
    const scannerExitCode = Number.parseInt(args['scanner-exit'], 10);
    // A non-numeric scanner exit is itself a fault (the workflow always passes it).
    const exitCode = Number.isFinite(scannerExitCode) ? scannerExitCode : 1;

    const resultsRead = readFileSafe(args.results);
    // A missing results file with a clean scanner exit means "no findings emitted";
    // with a non-zero exit it is a scanner failure (handled by exitCode below).
    const { findings, parseErrors } = parseResults(resultsRead.text);

    let baselineObj = { allow: [] };
    let baselineReadFailed = false;
    if (args.baseline) {
        const b = readFileSafe(args.baseline);
        if (b.missing) {
            baselineObj = { allow: [] }; // no baseline file == empty allowlist (still fails on new verified)
        } else {
            try {
                baselineObj = JSON.parse(b.text);
            } catch {
                baselineReadFailed = true; // unreadable baseline -> fail closed
            }
        }
    }
    const { set: baseline, malformed } = loadBaseline(baselineObj);

    const result = evaluate({
        findings,
        parseErrors,
        scannerExitCode: exitCode,
        baseline,
        baselineMalformed: malformed || baselineReadFailed,
    });

    const summary = renderSummary(result);
    const report = buildReport(result);

    if (args.summary) {
        try { fs.appendFileSync(args.summary, summary); } catch { /* summary is best-effort */ }
    }
    if (args.report) {
        try { fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n'); } catch { /* best-effort */ }
    }
    // Always echo the summary so the raw log is self-contained.
    process.stdout.write(summary);

    return result.shouldFail ? 1 : 0;
}

module.exports = {
    parseResults,
    gitMeta,
    fingerprint,
    isVerified,
    loadBaseline,
    evaluate,
    renderSummary,
    buildReport,
    main,
};

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
