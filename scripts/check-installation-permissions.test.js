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

test('rejects recursive Linux and Windows ACL grants on package trees', () => {
    fixture({
        'docs/recursive-acls.md': [
            'sudo setfacl -R -m u:jellyfin:rwx /usr/share/jellyfin/web',
            'setfacl --recursive --modify u:jellyfin:rwx /opt/jellyfin/jellyfin-web',
            'setfacl -Rm u:jellyfin:rwx /jellyfin/jellyfin-web',
            'icacls "C:\\Program Files\\Jellyfin\\Server" /grant "NT SERVICE\\Jellyfin:(OI)(CI)M" /T',
            'icacls C:\\Jellyfin\\Server /T /grant:r "NETWORK SERVICE:(CI)(OI)F"',
        ].join('\n'),
    }, (root) => {
        const problems = checkUnsafeGuidance(['docs/recursive-acls.md'], root);
        assert.equal(problems.length, 5);
        assert.equal(problems.filter(problem => /recursive Linux ACL grant/.test(problem)).length, 3);
        assert.equal(problems.filter(problem => /recursive Windows ACL grant/.test(problem)).length, 2);
    });
});

test('scans common shell and Windows command-script guidance files', () => {
    fixture({
        'ops/linux.bash': 'setfacl -R -m u:jellyfin:rwx /usr/lib/jellyfin',
        'ops/windows.ps1': 'icacls "C:\\Program Files\\Jellyfin\\Server" /grant "Users:(OI)(CI)M" /T',
        'ops/windows.cmd': 'icacls C:\\Jellyfin\\Server /T /grant:r Users:F',
    }, (root) => {
        const problems = checkUnsafeGuidance(undefined, root);
        assert.equal(problems.length, 3);
        assert.match(problems.join('\n'), /ops\/linux\.bash/);
        assert.match(problems.join('\n'), /ops\/windows\.ps1/);
        assert.match(problems.join('\n'), /ops\/windows\.cmd/);
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
            'sudo setfacl -m "u:${service_user}:rwx" -- "$index_dir"',
            'icacls "C:\\Program Files\\Jellyfin\\Server\\jellyfin-web" /grant "NT SERVICE\\Jellyfin:(M)"',
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
    assert.match(scripts['check:docs'], /node scripts\/check-installation-permissions\.js/);
});
