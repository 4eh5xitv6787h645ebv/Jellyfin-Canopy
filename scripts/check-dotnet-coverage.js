'use strict';

/**
 * Line-coverage ratchet for the plugin assembly.
 *
 * Reads the cobertura report(s) produced by
 *   dotnet test Jellyfin.Plugin.JellyfinCanopy.Tests/JellyfinCanopy.Tests.csproj \
 *     -c Release --collect:"XPlat Code Coverage"
 * (coverlet.collector), computes line coverage for the
 * Jellyfin.Plugin.JellyfinCanopy package and fails below the threshold.
 *
 * The threshold is read from scripts/coverage-baselines.json, shared with the
 * client gate. The artifact records exact repeated clean measurements, a tiny
 * instrumentation tolerance, and the complete instrumented scope. Coverage
 * or scope growth must update that reviewed artifact so gains cannot be lost.
 *
 * Usage: node scripts/check-dotnet-coverage.js
 */

const fs = require('fs');
const path = require('path');
const {
    evaluateCoverage,
    formatCoverage,
    loadBaselines,
} = require('./lib/coverage-baseline');

const RESULTS_ROOT = path.join(__dirname, '..', 'Jellyfin.Plugin.JellyfinCanopy.Tests', 'TestResults');

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
function measurePackage(xml, packageName = 'Jellyfin.Plugin.JellyfinCanopy') {
    const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const packagePattern = new RegExp(`<package[^>]*name="${escapedPackageName}"[^>]*>([\\s\\S]*?)</package>`);
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
    if (process.argv.length !== 2) {
        console.error('usage: node scripts/check-dotnet-coverage.js');
        process.exit(2);
    }
    let baselines;
    try {
        baselines = loadBaselines();
    } catch (error) {
        console.error(`check-dotnet-coverage: invalid coverage baseline — ${error.message}`);
        process.exit(2);
    }
    const profile = baselines.profiles.server;
    const packageName = profile.package;
    const reports = findReports(RESULTS_ROOT);
    if (reports.length === 0) {
        console.error(`check-dotnet-coverage: no coverage.cobertura.xml under ${RESULTS_ROOT}`);
        console.error('Run: dotnet test Jellyfin.Plugin.JellyfinCanopy.Tests/JellyfinCanopy.Tests.csproj -c Release --collect:"XPlat Code Coverage"');
        process.exit(2);
    }

    // Use the newest report (each collection run writes a fresh GUID directory).
    const newest = reports
        .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].file;

    const xml = fs.readFileSync(newest, 'utf8');
    const rawMeasurement = measurePackage(xml, packageName);
    if (!rawMeasurement || rawMeasurement.valid === 0) {
        console.error(`check-dotnet-coverage: package "${packageName}" not found in ${newest}`);
        const found = [...xml.matchAll(/<package[^>]*name="([^"]*)"/g)].map((m) => m[1]);
        console.error(`check-dotnet-coverage: packages present in the report: ${found.length ? found.join(', ') : '(none — empty coverage run)'}`);
        process.exit(2);
    }

    const measured = {
        coveredLines: rawMeasurement.covered,
        totalLines: rawMeasurement.valid,
    };
    const result = evaluateCoverage(measured, profile);
    const summary = formatCoverage(packageName, measured, profile, result);
    if (!result.ok) {
        console.error(`check-dotnet-coverage: FAIL (${result.reason}) — ${summary}`);
        process.exit(1);
    }
    console.log(`check-dotnet-coverage: OK — ${summary}`);
}

if (require.main === module) {
    main();
}

module.exports = { measurePackage };
