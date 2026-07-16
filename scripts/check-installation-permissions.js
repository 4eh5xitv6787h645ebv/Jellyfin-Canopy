'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REQUIRED_DOCS = ['README.md', 'docs/getting-started.md', 'docs/customization.md', 'docs/help.md', 'docs/about.md', 'docs/developers.md'];
const RUNTIME_FILES = {
    atomic: 'Jellyfin.Plugin.JellyfinCanopy/Configuration/AtomicFile.cs',
    config: 'Jellyfin.Plugin.JellyfinCanopy/Configuration/PluginConfiguration.cs',
    plugin: 'Jellyfin.Plugin.JellyfinCanopy/JellyfinCanopy.cs',
    startup: 'Jellyfin.Plugin.JellyfinCanopy/Services/StartupService.cs',
};

const UNSAFE_GUIDANCE = [
    {
        name: 'recursive ownership or mode change on a Jellyfin tree',
        pattern: /\b(?:chown|chmod)\b[^\n]*(?:\s-R\b|\s--recursive\b)[^\n]*(?:jellyfin|web)/giu,
    },
    {
        name: 'recursive Windows permission inheritance',
        pattern: /apply\s+(?:the change\s+)?to\s+all\s+subfolders\s+and\s+files/giu,
    },
    {
        name: 'broad write grant on the Jellyfin install folder',
        pattern: /grant[^\n]*(?:read\s*(?:and|\/)\s*write|modify|full control)[^\n]*(?:jellyfin|install(?:ation)?)[^\n]*(?:folder|directory|tree)/giu,
    },
    {
        name: 'copying a custom asset into the package-owned web tree',
        pattern: /\b(?:place|drop|copy)\b[^\n]*(?:web root|jellyfin web (?:directory|folder)|jellyfin-web)/giu,
    },
    {
        name: 'blanket File Transformation recommendation for Canopy',
        pattern: /file transformation[^\n]*(?:highly\s+recommended|required|common solution)[^\n]*(?:canopy|install)/giu,
    },
    {
        name: 'Docker copy-out workaround for package-owned index.html',
        pattern: /\bdocker\s+cp\b[^\n]*\bjellyfin-web\/index\.html\b/giu,
    },
    {
        name: 'single-file Docker bind mount over package-owned index.html',
        pattern: /^\s*-\s*[^\n#]*index\.html\s*:\s*[^\n#]*(?:jellyfin-web|\/web)\/index\.html(?:\s*:\s*(?:ro|rw))?\s*$/gimu,
    },
];

function lineNumber(source, index) {
    return source.slice(0, index).split('\n').length;
}

function collectGuidanceFiles(root = ROOT) {
    const files = [];
    const excludedDirectories = new Set(['.git', 'bin', 'coverage', 'node_modules', 'obj', 'site']);
    const guidanceExtensions = new Set(['.md', '.sh', '.yaml', '.yml']);
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && guidanceExtensions.has(path.extname(entry.name).toLowerCase())) {
                files.push(path.relative(root, absolute));
            }
        }
    };
    visit(root);
    return files;
}

function checkUnsafeGuidance(files, root = ROOT) {
    const selected = files || collectGuidanceFiles(root);
    const problems = [];
    for (const file of selected) {
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) {
            problems.push(`${file}: required installation document is missing`);
            continue;
        }
        const source = fs.readFileSync(absolute, 'utf8');
        for (const rule of UNSAFE_GUIDANCE) {
            rule.pattern.lastIndex = 0;
            for (const match of source.matchAll(rule.pattern)) {
                problems.push(`${file}:${lineNumber(source, match.index)}: ${rule.name}`);
            }
        }
    }
    return problems;
}

function requirePattern(problems, source, file, pattern, description) {
    if (!pattern.test(source)) problems.push(`${file}: ${description}`);
}

function readRuntimeSources(root, problems) {
    const sources = {};
    for (const [name, file] of Object.entries(RUNTIME_FILES)) {
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) {
            problems.push(`${file}: runtime permission-contract source is missing`);
            sources[name] = '';
        } else {
            sources[name] = fs.readFileSync(absolute, 'utf8');
        }
    }
    return sources;
}

function checkRuntimeContract(root = ROOT) {
    const problems = [];
    const sources = readRuntimeSources(root, problems);
    requirePattern(
        problems,
        sources.config,
        RUNTIME_FILES.config,
        /DisableScriptInjectionMiddleware\s*=\s*false\s*;/,
        'script middleware must remain enabled by default',
    );
    requirePattern(
        problems,
        sources.config,
        RUNTIME_FILES.config,
        /DisableBrandingMiddleware\s*=\s*false\s*;/,
        'branding middleware must remain enabled by default',
    );
    requirePattern(
        problems,
        sources.startup,
        RUNTIME_FILES.startup,
        /config\s*!=\s*null\s*&&\s*config\.DisableScriptInjectionMiddleware/,
        'legacy on-disk startup rewrite must remain opt-in',
    );
    requirePattern(
        problems,
        sources.plugin,
        RUNTIME_FILES.plugin,
        /IndexHtmlPath\s*=>\s*Path\.Combine\(_applicationPaths\.WebPath,\s*"index\.html"\)/,
        'legacy rewrite target must remain the resolved web-path index.html',
    );
    requirePattern(
        problems,
        sources.plugin,
        RUNTIME_FILES.plugin,
        /BrandingDirectory\s*=>\s*GetPluginDataSubdirectory\("custom_branding"\)/,
        'branding storage must remain beside the plugin configuration',
    );
    requirePattern(
        problems,
        sources.plugin,
        RUNTIME_FILES.plugin,
        /CleanupOldScript\(\)\s*;/,
        'best-effort stale legacy-tag cleanup must remain represented in the docs',
    );
    requirePattern(
        problems,
        sources.atomic,
        RUNTIME_FILES.atomic,
        /var temp = path \+ "\.tmp\."[\s\S]*File\.Move\(temp, path, overwrite: true\)/,
        'legacy writes must retain their temporary-sibling atomic rename semantics',
    );
    return problems;
}

function checkDocumentationContract(root = ROOT) {
    const problems = checkUnsafeGuidance(undefined, root);
    for (const file of REQUIRED_DOCS) {
        if (!fs.existsSync(path.join(root, file))) {
            problems.push(`${file}: required installation document is missing`);
        }
    }
    const expectations = [
        ['README.md', /do(?:es)? not need write access to Jellyfin's web or installation tree/, 'state the default no-install-tree-write contract'],
        ['docs/getting-started.md', /Default Jellyfin 12 permission contract/, 'contain the canonical permission contract'],
        ['docs/getting-started.md', /creates and writes a temporary sibling, then atomically replaces the destination/, 'explain the exact legacy directory operations'],
        ['docs/getting-started.md', /Do not wait for a success log to identify the path/, 'use deterministic legacy-path discovery instead of a nonexistent success-path log'],
        ['docs/getting-started.md', /systemctl show[\s\S]*setfacl -m/, 'provide concrete Linux service discovery and narrow ACL commands'],
        ['docs/getting-started.md', /Get-CimInstance Win32_Service[\s\S]*FileSystemAccessRule/, 'provide concrete Windows service discovery and narrow ACL commands'],
        ['docs/getting-started.md', /Docker has no supported legacy fallback/, 'prohibit unsupported container copy and bind-mount workarounds'],
        ['docs/getting-started.md', /best-effort attempt to remove a stale on-disk Canopy tag/, 'explain the non-fatal migration cleanup attempt'],
        ['docs/getting-started.md', /`index\.html` is package-owned/, 'explain upgrade and package ownership semantics'],
        ['docs/getting-started.md', /Those same steps are the rollback procedure/, 'document legacy rollback'],
        ['docs/customization.md', /directory that contains Canopy's plugin configuration/, 'identify the actual branding storage owner boundary'],
        ['docs/customization.md', /Do not copy the image into Jellyfin's package-owned web directory/, 'keep splash assets out of the web tree'],
        ['docs/customization.md', /LAN-only HTTP is supported[\s\S]*use HTTPS for an externally hosted production image/, 'preserve supported splash URL forms and scope the HTTPS requirement'],
        ['docs/help.md', /Default Canopy does not need write access to this file/, 'route permission errors through the default contract'],
        ['docs/about.md', /does not use or require it/, 'keep File Transformation explicitly optional'],
        ['docs/developers.md', /Legacy on-disk `index\.html` rewrite \| \*\*STAYS as an explicit fallback only\*\* when `DisableScriptInjectionMiddleware=true`; `CleanupOldScript` separately remains as best-effort migration cleanup/, 'keep the developer fallback matrix aligned with runtime'],
    ];
    for (const [file, pattern, description] of expectations) {
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) continue;
        requirePattern(problems, fs.readFileSync(absolute, 'utf8'), file, pattern, description);
    }
    return problems;
}

function checkInstallationPermissions(root = ROOT) {
    return [...checkDocumentationContract(root), ...checkRuntimeContract(root)];
}

function main() {
    const problems = checkInstallationPermissions();
    if (problems.length > 0) {
        console.error(`Installation permission contract failed:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    console.log('Installation permission contract OK');
}

if (require.main === module) main();

module.exports = {
    checkDocumentationContract,
    checkInstallationPermissions,
    checkRuntimeContract,
    checkUnsafeGuidance,
    collectGuidanceFiles,
};
