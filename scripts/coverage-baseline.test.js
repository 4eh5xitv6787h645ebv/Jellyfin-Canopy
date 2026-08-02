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

test('reviewed coverage baselines match the clean measurement envelopes', () => {
    assert.equal(baselines.schemaVersion, 2);
    assert.equal(baselines.policy.baselineSelection, 'observed-high-water');
    assert.match(baselines.policy.description, /high-water never decreases/);
    assert.match(
        baselines.policy.description,
        /exact minimum directly observed by clean runs on the identical source, tests, and total-line scope/
    );
    assert.deepEqual(baselines.profiles.client.measured, { coveredLines: 2808, totalLines: 3201 });
    assert.deepEqual(baselines.profiles.server.measured, { coveredLines: 31619, totalLines: 40248 });
    assert.deepEqual(baselines.profiles.client.observations, {
        cleanRuns: 3,
        minimumCoveredLines: 2808,
        maximumCoveredLines: 2808,
    });
    assert.deepEqual(baselines.profiles.server.observations, {
        cleanRuns: 3,
        minimumCoveredLines: 31618,
        maximumCoveredLines: 31619,
    });
    assert.equal(baselines.profiles.client.tolerance.missingCoveredLines, 0);
    assert.equal(baselines.profiles.server.tolerance.missingCoveredLines, 1);
});

for (const name of ['client', 'server']) {
    test(`${name} gate accepts its exact reviewed baseline and reviewed instrumentation floor`, () => {
        const profile = baselines.profiles[name];
        assert.equal(evaluateCoverage(profile.measured, profile).reason, 'exact');
        const tolerated = {
            coveredLines: minimumCoveredLines(profile),
            totalLines: profile.measured.totalLines,
        };
        const result = evaluateCoverage(tolerated, profile);
        assert.deepEqual(result, profile.tolerance.missingCoveredLines === 0
            ? {
                ok: true,
                reason: 'exact',
                message: 'measurement matches the reviewed observed high-water',
            }
            : {
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

test('reviewed high-water accepts its bounded variants and rejects both outer edges', () => {
    const profile = {
        scope: 'synthetic fixed assembly scope',
        measured: { coveredLines: 19201, totalLines: 27479 },
        observations: {
            cleanRuns: 4,
            minimumCoveredLines: 19199,
            maximumCoveredLines: 19201,
        },
        tolerance: {
            missingCoveredLines: 2,
            rationale: 'Synthetic two-line instrumentation envelope.',
        },
    };
    const document = {
        schemaVersion: 2,
        policy: {
            baselineSelection: 'observed-high-water',
            maximumTolerancePercentagePoints: 0.15,
        },
        profiles: {
            client: JSON.parse(JSON.stringify(profile)),
            server: JSON.parse(JSON.stringify(profile)),
        },
    };

    assert.doesNotThrow(() => validateBaselineDocument(document));
    for (const coveredLines of [19199, 19200, 19201]) {
        assert.equal(evaluateCoverage({ coveredLines, totalLines: 27479 }, profile).ok, true);
    }
    assert.equal(evaluateCoverage({ coveredLines: 19198, totalLines: 27479 }, profile).reason, 'regression');
    assert.equal(evaluateCoverage({ coveredLines: 19202, totalLines: 27479 }, profile).reason, 'stale-baseline');

    const selectedLowerValue = JSON.parse(JSON.stringify(document));
    selectedLowerValue.profiles.server.measured.coveredLines = 19200;
    assert.throws(
        () => validateBaselineDocument(selectedLowerValue),
        /coveredLines must equal the observed high-water 19201/,
    );

    const widerThanTolerance = JSON.parse(JSON.stringify(document));
    widerThanTolerance.profiles.server.observations.minimumCoveredLines = 19198;
    assert.throws(
        () => validateBaselineDocument(widerThanTolerance),
        /observations spread 3 exceeds the 2-line instrumentation tolerance/,
    );

    const singleRun = JSON.parse(JSON.stringify(document));
    singleRun.profiles.server.observations.cleanRuns = 1;
    assert.throws(
        () => validateBaselineDocument(singleRun),
        /observations\.cleanRuns must be an integer >= 2/,
    );
});

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
