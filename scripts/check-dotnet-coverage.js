'use strict';

/**
 * Line-coverage ratchet for the plugin assembly.
 *
 * Reads the cobertura report(s) produced by
 *   dotnet test Jellyfin.Plugin.JellyfinEnhanced.Tests/JellyfinEnhanced.Tests.csproj \
 *     -c Release --collect:"XPlat Code Coverage"
 * (coverlet.collector), computes line coverage for the
 * Jellyfin.Plugin.JellyfinEnhanced package and fails below the threshold.
 *
 * The threshold is a RATCHET: it was set just below the measured coverage at
 * introduction (17.72% on 2026-07-04). When you add tests and the number
 * rises, move the threshold up to just below the new number — never down.
 *
 * Usage: node scripts/check-dotnet-coverage.js [--threshold <percent>]
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = 'Jellyfin.Plugin.JellyfinEnhanced';
const DEFAULT_THRESHOLD = 16;
const RESULTS_ROOT = path.join(__dirname, '..', 'Jellyfin.Plugin.JellyfinEnhanced.Tests', 'TestResults');

function parseThreshold(argv) {
    const flagIndex = argv.indexOf('--threshold');
    if (flagIndex === -1) return DEFAULT_THRESHOLD;
    const value = Number(argv[flagIndex + 1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        console.error(`check-dotnet-coverage: invalid --threshold "${argv[flagIndex + 1]}"`);
        process.exit(2);
    }
    return value;
}

/** Recursively collect every coverage.cobertura.xml under TestResults/. */
function findReports(dir) {
    if (!fs.existsSync(dir)) return [];
    const reports = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            reports.push(...findReports(full));
        } else if (entry.name === 'coverage.cobertura.xml') {
            reports.push(full);
        }
    }
    return reports;
}

/**
 * Extract the plugin package's <line hits=...> counts from a cobertura report.
 * Deliberately regex-based (the report is machine-generated and this script
 * must run with zero dependencies): isolate the <package name="..."> block,
 * then count line elements and their hits.
 *
 * coverlet emits each covered line TWICE — once under <method><lines> and again
 * under the enclosing <class><lines>. Counting every <line> globally therefore
 * double-counts most lines (and not self-cancellingly: the class-level <lines>
 * also carry lines outside any method, e.g. field/property initializers). We
 * count only the class-level <lines> — the authoritative complete set — by
 * stripping each class's <methods> section before counting.
 */
function measurePackage(xml) {
    const packagePattern = new RegExp(`<package[^>]*name="${PACKAGE_NAME}"[^>]*>([\\s\\S]*?)</package>`);
    const match = xml.match(packagePattern);
    if (!match) return null;

    let valid = 0;
    let covered = 0;
    const classPattern = /<class\b[\s\S]*?<\/class>/g;
    const linePattern = /<line[^>]*\bhits="(\d+)"[^>]*>/g;
    let classMatch;
    while ((classMatch = classPattern.exec(match[1])) !== null) {
        // Drop the method-level lines; the class-level <lines> remain.
        const classXml = classMatch[0].replace(/<methods>[\s\S]*?<\/methods>/g, '');
        let lineMatch;
        linePattern.lastIndex = 0;
        while ((lineMatch = linePattern.exec(classXml)) !== null) {
            valid += 1;
            if (Number(lineMatch[1]) > 0) covered += 1;
        }
    }
    return { valid, covered };
}

function main() {
    const threshold = parseThreshold(process.argv.slice(2));
    const reports = findReports(RESULTS_ROOT);
    if (reports.length === 0) {
        console.error(`check-dotnet-coverage: no coverage.cobertura.xml under ${RESULTS_ROOT}`);
        console.error('Run: dotnet test Jellyfin.Plugin.JellyfinEnhanced.Tests/JellyfinEnhanced.Tests.csproj -c Release --collect:"XPlat Code Coverage"');
        process.exit(2);
    }

    // Use the newest report (each collection run writes a fresh GUID directory).
    const newest = reports
        .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].file;

    const measured = measurePackage(fs.readFileSync(newest, 'utf8'));
    if (!measured || measured.valid === 0) {
        console.error(`check-dotnet-coverage: package "${PACKAGE_NAME}" not found in ${newest}`);
        process.exit(2);
    }

    const percent = (100 * measured.covered) / measured.valid;
    const summary = `${PACKAGE_NAME}: ${measured.covered}/${measured.valid} lines = ${percent.toFixed(2)}% (threshold ${threshold}%)`;
    if (percent < threshold) {
        console.error(`check-dotnet-coverage: FAIL — ${summary}`);
        process.exit(1);
    }
    console.log(`check-dotnet-coverage: OK — ${summary}`);
}

if (require.main === module) {
    main();
}

module.exports = { measurePackage };
