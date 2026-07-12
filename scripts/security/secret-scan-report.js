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
 * Run via `npm run test:scripts` (unit) or as the workflow step (results/report
 * live under $RUNNER_TEMP, outside the PR-controlled checkout):
 *   node scripts/security/secret-scan-report.js \
 *     --results "$RUNNER_TEMP/secret-scan/results.jsonl" --scanner-exit "$CODE" \
 *     --baseline .github/secret-scan-baseline.json \
 *     --summary "$GITHUB_STEP_SUMMARY" --report "$RUNNER_TEMP/secret-scan/report.json"
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

/** Whether a finding carries usable raw identity (at least one of Raw/RawV2).
 * A verified finding without it cannot be safely fingerprinted for allowlisting. */
function hasRawIdentity(finding) {
    return !!(finding && ((typeof finding.Raw === 'string' && finding.Raw !== '')
        || (typeof finding.RawV2 === 'string' && finding.RawV2 !== '')));
}

/** Fully-opaque, secret-free fingerprint: a single SHA-256 over a length-delimited
 * canonical tuple of (DetectorName, file, Raw, RawV2). Both raw fields are folded
 * in (composite detectors put distinct credential parts in each), and the whole
 * digest is used (no truncation). Because the file path is folded INTO the hash
 * rather than concatenated in the clear, a filename that itself contains secret
 * material is not exposed by the fingerprint. */
function fingerprint(finding) {
    const detector = (finding && finding.DetectorName) || 'unknown';
    const { file } = gitMeta(finding);
    const raw = (finding && typeof finding.Raw === 'string') ? finding.Raw : '';
    const rawV2 = (finding && typeof finding.RawV2 === 'string') ? finding.RawV2 : '';
    const canonical = [detector, file, raw, rawV2]
        .map((s) => `${Buffer.byteLength(String(s), 'utf8')}:${s}`)
        .join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function isVerified(finding) {
    return finding && finding.Verified === true;
}

/** Redact any raw-secret occurrence from a string that will be DISPLAYED (the Git
 * path is scanner-controlled and can itself contain the secret, e.g. a file named
 * `leak-<token>.txt`). Only reasonably-long secret values are substituted so
 * ordinary path components aren't mangled; the original value is used solely
 * inside the one-way fingerprint, never in the report/summary/artifact. */
function redactSecrets(text, secrets) {
    let out = String(text == null ? '' : text);
    for (const s of secrets) {
        if (typeof s === 'string' && s.length >= 6) {
            out = out.split(s).join('<redacted-secret>');
        }
    }
    return out;
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
        // An allowlist entry is honored ONLY when it has both a non-empty
        // fingerprint AND a non-empty reason. A reason-less entry is ignored (so
        // that finding is NOT allowlisted and still fails) — the documented
        // "every entry must carry a reason" governance rule, enforced.
        if (entry
            && typeof entry.fingerprint === 'string' && entry.fingerprint.trim() !== ''
            && typeof entry.reason === 'string' && entry.reason.trim() !== '') {
            set.add(entry.fingerprint.trim());
        }
    }
    return { set, malformed: false };
}

/**
 * Core decision. Returns a structured result; the caller renders + sets exit code.
 */
function evaluate({ findings, parseErrors, scannerExitCode, baseline, baselineMalformed }) {
    // Aggregate by fingerprint BEFORE classifying, and make verification MONOTONIC:
    // if any record for a fingerprint is verified, the aggregate is verified. This
    // prevents an unverified-first / verified-second ordering from dropping the
    // verified occurrence.
    const byFp = new Map();
    for (const f of findings) {
        const fp = fingerprint(f);
        const { file, line } = gitMeta(f);
        const verified = isVerified(f);
        const rawId = hasRawIdentity(f);
        const existing = byFp.get(fp);
        if (existing) {
            existing.verified = existing.verified || verified;
            existing.hasRawIdentity = existing.hasRawIdentity || rawId;
        } else {
            // Redact any secret material out of the DISPLAYED path before it is
            // stored on the item (which is serialized into the report/summary/
            // artifact). The unredacted path is only ever fed to fingerprint().
            const rawSecrets = [f && f.Raw, f && f.RawV2];
            const safeFile = redactSecrets(file, rawSecrets);
            byFp.set(fp, { detector: redactSecrets(f.DetectorName || 'unknown', rawSecrets), file: safeFile, line, verified, fingerprint: fp, hasRawIdentity: rawId });
        }
    }

    const verifiedNew = [];
    const unverifiedNew = [];
    const baselinedHits = [];
    for (const item of byFp.values()) {
        // A verified finding without raw identity (no Raw/RawV2) cannot be safely
        // allowlisted by content, so it is never treated as baselined — it always
        // blocks.
        const baselinable = item.hasRawIdentity;
        if (baselinable && baseline.has(item.fingerprint)) {
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

    // The results path MUST be a real, regular file the workflow just wrote — not a
    // symlink or special file. A malicious PR could commit e.g.
    // `results.jsonl -> /dev/null` inside the checkout to silently discard the
    // scanner's findings (or `-> /dev/stderr` to leak Raw into logs). The workflow
    // now writes under $RUNNER_TEMP (outside the PR checkout), and this is
    // defense-in-depth: anything but a regular file — or a missing file — fails
    // closed, since with the redirect a regular file is always created.
    let resultsFault = null;
    try {
        const st = fs.lstatSync(args.results);
        if (st.isSymbolicLink()) resultsFault = 'scanner results path is a symlink (rejected)';
        else if (!st.isFile()) resultsFault = 'scanner results path is not a regular file';
    } catch {
        resultsFault = 'scanner results file is missing';
    }
    const resultsRead = resultsFault ? { text: '', missing: true } : readFileSafe(args.results);
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

    // A tampered/absent results file fails closed regardless of the finding set.
    if (resultsFault) {
        result.reasons.unshift(resultsFault);
        result.shouldFail = true;
    }

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
