'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { readClientMeasurement } = require('./check-client-coverage');
const { measurePackage } = require('./check-dotnet-coverage');
const {
    evaluateCoverage,
    loadBaselines,
    minimumCoveredLines,
    validateBaselineDocument,
} = require('./lib/coverage-baseline');

const ROOT = path.join(__dirname, '..');
const baselines = loadBaselines();

test('reviewed coverage baselines match the repeated clean measurements', () => {
    assert.deepEqual(baselines.profiles.client.measured, { coveredLines: 1439, totalLines: 1762 });
    assert.deepEqual(baselines.profiles.server.measured, { coveredLines: 18168, totalLines: 26709 });
    assert.equal(baselines.profiles.client.tolerance.missingCoveredLines, 1);
    assert.equal(baselines.profiles.server.tolerance.missingCoveredLines, 2);
});

for (const name of ['client', 'server']) {
    test(`${name} gate accepts its exact reviewed baseline and narrow instrumentation tolerance`, () => {
        const profile = baselines.profiles[name];
        assert.equal(evaluateCoverage(profile.measured, profile).reason, 'exact');
        const tolerated = {
            coveredLines: minimumCoveredLines(profile),
            totalLines: profile.measured.totalLines,
        };
        assert.deepEqual(evaluateCoverage(tolerated, profile), {
            ok: true,
            reason: 'within-tolerance',
            message: `measurement is within the ${profile.tolerance.missingCoveredLines}-line instrumentation tolerance`,
        });
    });

    test(`${name} negative fixture fails after representative covered lines are removed`, () => {
        const profile = baselines.profiles[name];
        const dropped = {
            coveredLines: minimumCoveredLines(profile) - 12,
            totalLines: profile.measured.totalLines,
        };
        const result = evaluateCoverage(dropped, profile);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'regression');
    });

    test(`${name} gate requires a reviewed update when coverage or scope advances`, () => {
        const profile = baselines.profiles[name];
        assert.equal(evaluateCoverage({
            coveredLines: profile.measured.coveredLines + 1,
            totalLines: profile.measured.totalLines,
        }, profile).reason, 'stale-baseline');
        assert.equal(evaluateCoverage({
            coveredLines: profile.measured.coveredLines,
            totalLines: profile.measured.totalLines + 1,
        }, profile).reason, 'scope-drift');
    });
}

test('baseline policy rejects a broad tolerance increase', () => {
    const fixture = JSON.parse(JSON.stringify(baselines));
    fixture.profiles.client.tolerance.missingCoveredLines = 20;
    assert.throws(() => validateBaselineDocument(fixture), /above the policy maximum/);
});

test('client negative coverage-summary fixture fails through report parsing and the gate', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-client-coverage-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reportFile = path.join(directory, 'coverage-summary.json');
    const profile = baselines.profiles.client;
    fs.writeFileSync(reportFile, JSON.stringify({
        total: {
            lines: {
                covered: minimumCoveredLines(profile) - 12,
                total: profile.measured.totalLines,
                skipped: 0,
                pct: 0,
            },
        },
    }));

    const measured = readClientMeasurement(reportFile);
    assert.equal(evaluateCoverage(measured, profile).reason, 'regression');
});

test('server negative Cobertura fixture fails through package parsing and the gate', () => {
    const profile = baselines.profiles.server;
    const covered = minimumCoveredLines(profile) - 12;
    const lines = Array.from({ length: profile.measured.totalLines }, (_, index) =>
        `<line number="${index + 1}" hits="${index < covered ? 1 : 0}"/>`).join('');
    const xml = `<coverage><packages><package name="${profile.package}"><classes>`
        + `<class name="Fixture"><methods></methods><lines>${lines}</lines></class>`
        + '</classes></package></packages></coverage>';
    const parsed = measurePackage(xml, profile.package);
    assert.ok(parsed);
    const measured = { coveredLines: parsed.covered, totalLines: parsed.valid };
    assert.deepEqual(measured, { coveredLines: covered, totalLines: profile.measured.totalLines });
    assert.equal(evaluateCoverage(measured, profile).reason, 'regression');
});

test('server package matching treats regex metacharacters as literal text', () => {
    const xml = '<coverage><package name="A.B+C"><class><methods></methods>'
        + '<lines><line number="1" hits="1"/></lines></class></package>'
        + '<package name="AxBBBBC"><class><methods></methods>'
        + '<lines><line number="1" hits="0"/></lines></class></package></coverage>';
    assert.deepEqual(measurePackage(xml, 'A.B+C'), { valid: 1, covered: 1 });
});

test('client report parser fails closed on missing and non-integer line evidence', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-client-coverage-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reportFile = path.join(directory, 'coverage-summary.json');
    fs.writeFileSync(reportFile, JSON.stringify({ total: { lines: { covered: 1.5, total: 2 } } }));
    assert.throws(() => readClientMeasurement(reportFile), /no integer total\.lines counts/);
});

test('local and CI coverage entry points share the committed artifact', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const vitest = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    const runner = fs.readFileSync(path.join(__dirname, 'run-coverage-suite.js'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, 'check-dotnet-coverage.js'), 'utf8');
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');

    assert.equal(packageJson.scripts['test:client:coverage'], 'node scripts/run-coverage-suite.js client');
    assert.equal(packageJson.scripts['test:server:coverage'], 'node scripts/run-coverage-suite.js server');
    assert.match(runner, /check-client-coverage\.js/);
    assert.match(runner, /check-dotnet-coverage\.js/);
    assert.match(vitest, /coverage-baselines\.json/);
    assert.match(vitest, /include:\s*\[clientBaseline\.scope\]/);
    assert.doesNotMatch(vitest, /thresholds:/);
    assert.match(server, /loadBaselines\(\)/);
    assert.match(workflow, /npm run test:client:coverage/);
    assert.match(workflow, /npm run test:server:coverage/);
    assert.doesNotMatch(vitest, /lines:\s*47\b/);
    assert.doesNotMatch(server, /DEFAULT_THRESHOLD\s*=\s*16\b/);
});
