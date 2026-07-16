'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    checkInstallationPermissions,
    checkRuntimeContract,
    checkUnsafeGuidance,
} = require('./check-installation-permissions');

function fixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-install-permissions-'));
    try {
        for (const [name, contents] of Object.entries(files)) {
            const destination = path.join(root, name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, contents);
        }
        callback(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('live installation guidance matches the runtime permission contract', () => {
    assert.deepEqual(checkInstallationPermissions(), []);
});

test('rejects broad recursive grants and package web-tree asset copies', () => {
    fixture({
        'docs/bad.md': [
            'sudo chown -R jellyfin:jellyfin /usr/lib/jellyfin/',
            'Grant NETWORK SERVICE Read and Write to the Jellyfin installation folder.',
            'Apply to all subfolders and files.',
            'Drop the image in the Jellyfin web directory.',
        ].join('\n'),
    }, (root) => {
        const problems = checkUnsafeGuidance(['docs/bad.md'], root);
        assert.equal(problems.length, 4);
        assert.match(problems.join('\n'), /recursive ownership or mode change/);
        assert.match(problems.join('\n'), /broad write grant/);
        assert.match(problems.join('\n'), /recursive Windows permission inheritance/);
        assert.match(problems.join('\n'), /package-owned web tree/);
    });
});

test('rejects Docker copy-out and single-file bind-mount legacy workarounds', () => {
    fixture({
        'docs/docker-bad.md': [
            'docker cp jellyfin:/jellyfin/jellyfin-web/index.html /srv/jellyfin/index.html',
            'volumes:',
            '  - /srv/jellyfin/index.html:/jellyfin/jellyfin-web/index.html:rw',
        ].join('\n'),
    }, (root) => {
        const problems = checkUnsafeGuidance(['docs/docker-bad.md'], root);
        assert.equal(problems.length, 2);
        assert.match(problems.join('\n'), /Docker copy-out workaround/);
        assert.match(problems.join('\n'), /single-file Docker bind mount/);
    });
});

test('accepts narrowly scoped legacy and default-middleware explanations', () => {
    fixture({
        'docs/good.md': [
            'Default Canopy does not write Jellyfin binaries.',
            'For optional legacy mode, back up the exact index.html and grant only its service principal.',
            'Restore the backup and remove only the temporary ACL during rollback.',
        ].join('\n'),
    }, root => assert.deepEqual(checkUnsafeGuidance(['docs/good.md'], root), []));
});

test('runtime check fails when a middleware default drifts to disabled', () => {
    const files = {
        'Jellyfin.Plugin.JellyfinCanopy/Configuration/AtomicFile.cs': 'var temp = path + ".tmp."; File.Move(temp, path, overwrite: true);',
        'Jellyfin.Plugin.JellyfinCanopy/Configuration/PluginConfiguration.cs': 'DisableScriptInjectionMiddleware = true; DisableBrandingMiddleware = false;',
        'Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.cs': 'CleanupOldScript(); IndexHtmlPath => Path.Combine(_applicationPaths.WebPath, "index.html"); BrandingDirectory => GetPluginDataSubdirectory("custom_branding");',
        'Jellyfin.Plugin.JellyfinCanopy/Services/StartupService.cs': 'if (config != null && config.DisableScriptInjectionMiddleware) {}',
    };
    fixture(files, (root) => {
        const problems = checkRuntimeContract(root);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /script middleware must remain enabled by default/);
    });
});

test('the blocking Markdown gate cannot omit the installation contract', () => {
    const root = path.join(__dirname, '..');
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(
        scripts['check:markdown-links'],
        /node scripts\/check-markdown-links\.js && node scripts\/check-installation-permissions\.js/,
    );
});
