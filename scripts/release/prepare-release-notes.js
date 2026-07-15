#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const {
    MAX_CHANGELOG_BYTES,
    MAX_CHANGELOG_LINES,
} = require('./validate-manifest.js');

const SUMMARY_START = '<!-- jellyfin-canopy-catalog-summary:start -->';
const SUMMARY_END = '<!-- jellyfin-canopy-catalog-summary:end -->';
const GENERATED_MARKER_PREFIX = '<!-- jellyfin-canopy-generated-release-notes:v1 ';
const MIGRATION_RE = /\b(?:migrat(?:e(?:d|s)?|ing|ions?)|upgrad(?:e|ed|es|ing))\b/i;
const SECURITY_RE = /\b(?:cve(?:s|(?:-\d+)*)|secur(?:e(?:d|s)?|ing|ity)|vulnerab(?:ilities|ility|le))\b/i;
const BREAKING_RE = /(?:^[a-z][\w-]*(?:\([^)]*\))?!:|\bbreaking\b)/im;
const PRIORITY_RE = new RegExp(
    `(?:${BREAKING_RE.source}|${SECURITY_RE.source}|${MIGRATION_RE.source})`,
    'im'
);
const INTERNAL_RE = /(?:^(?:build|chore|ci|docs|refactor|style|test)(?:\([^)]*\))?!?:|\b(?:internal refactor|test fixture|ci workflow)\b)/i;
const PRIORITY_CATEGORIES = [
    ['security', SECURITY_RE],
    ['breaking', BREAKING_RE],
    ['migration/upgrade', MIGRATION_RE],
];

class ReleaseNotesError extends Error {}

function normalizeText(value) {
    return value.replace(/\r\n?/g, '\n').trim();
}

function neutralizeMentions(value) {
    return value.replace(/(^|[^`\p{L}\p{N}_])@([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu, '$1`@$2`');
}

function extractMarkedSummary(body) {
    const start = body.indexOf(SUMMARY_START);
    const end = body.indexOf(SUMMARY_END);
    if (start === -1 && end === -1) return null;
    if (start === -1 || end === -1 || end < start) {
        throw new ReleaseNotesError('catalog-summary markers must appear once and in start/end order');
    }
    if (body.indexOf(SUMMARY_START, start + SUMMARY_START.length) !== -1
        || body.indexOf(SUMMARY_END, end + SUMMARY_END.length) !== -1) {
        throw new ReleaseNotesError('catalog-summary markers must appear exactly once');
    }
    const summary = normalizeText(body.slice(start + SUMMARY_START.length, end));
    if (summary.length === 0) throw new ReleaseNotesError('catalog summary is empty');
    return summary;
}

function fullReleaseUrl(repo, tag) {
    return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

function generatedMarker(repo, tag) {
    return `${GENERATED_MARKER_PREFIX}repo=${repo} tag=${tag} -->`;
}

function generatedFullNotes(commits, repo, tag) {
    return `${commits.map(bullet).join('\n')}\n\n${generatedMarker(repo, tag)}`;
}

function containsGeneratedMarker(body) {
    return body.includes(GENERATED_MARKER_PREFIX);
}

function catalogWithLink(summary, repo, tag) {
    return `${normalizeText(summary)}\n\nFull release notes: ${fullReleaseUrl(repo, tag)}`;
}

function requirePriorityCategories(fullNotes, summary) {
    const missing = PRIORITY_CATEGORIES
        .filter(([, pattern]) => pattern.test(fullNotes) && !pattern.test(summary))
        .map(([name]) => name);
    if (missing.length > 0) {
        throw new ReleaseNotesError(
            `catalog summary omits priority categories present in full notes: ${missing.join(', ')}`
        );
    }
}

function budgetErrors(changelog) {
    const bytes = Buffer.byteLength(changelog, 'utf8');
    const lines = changelog.split('\n').length;
    const errors = [];
    if (bytes > MAX_CHANGELOG_BYTES) {
        errors.push(`${bytes} bytes exceeds the ${MAX_CHANGELOG_BYTES}-byte catalog limit`);
    }
    if (lines > MAX_CHANGELOG_LINES) {
        errors.push(`${lines} lines exceeds the ${MAX_CHANGELOG_LINES}-line catalog limit`);
    }
    return errors;
}

function assertCatalogBudget(changelog, context) {
    const errors = budgetErrors(changelog);
    if (errors.length > 0) {
        throw new ReleaseNotesError(`${context}: ${errors.join('; ')}`);
    }
}

function bullet(subject) {
    return `- ${neutralizeMentions(normalizeText(subject))}`;
}

function selectCommitSummary(subjects, repo, tag) {
    const normalized = subjects.map(normalizeText).filter(Boolean);
    if (normalized.length === 0) throw new ReleaseNotesError('release notes are empty');

    const prioritized = normalized.filter(subject => PRIORITY_RE.test(subject));
    const ordinary = normalized.filter(subject => !PRIORITY_RE.test(subject) && !INTERNAL_RE.test(subject));
    const selected = [...prioritized];
    const appendIfFits = (subject) => {
        const candidate = catalogWithLink([...selected, subject].map(bullet).join('\n'), repo, tag);
        if (budgetErrors(candidate).length === 0) {
            selected.push(subject);
            return true;
        }
        return false;
    };

    for (const subject of ordinary) appendIfFits(subject);
    if (selected.length === 0) selected.push('Maintenance release; see the full notes for complete changes.');
    const changelog = catalogWithLink(selected.map(bullet).join('\n'), repo, tag);
    assertCatalogBudget(
        changelog,
        'security, breaking, migration, and upgrade notes do not fit; create a curated draft summary'
    );
    return changelog;
}

function prepareReleaseNotes({ repo, tag, draftBody = '', commitSubjects = [], firstRelease = false }) {
    let body = normalizeText(draftBody);
    const commits = commitSubjects.map(normalizeText).filter(Boolean);

    if (containsGeneratedMarker(body)) {
        if (commits.length === 0) {
            throw new ReleaseNotesError('generated release notes cannot be verified without commit subjects');
        }
        const expected = generatedFullNotes(commits, repo, tag);
        if (body !== expected) {
            throw new ReleaseNotesError(
                'generated release notes were edited or belong to another release; remove the generated marker and provide a curated catalog summary'
            );
        }
        body = '';
    }

    if (body.length === 0 && commits.length === 0) {
        throw new ReleaseNotesError('release notes are empty');
    }
    if (firstRelease && body.length === 0) {
        throw new ReleaseNotesError(
            'the first release requires a curated pre-draft body; refusing to publish the full repository history'
        );
    }

    const fullNotes = body || generatedFullNotes(commits, repo, tag);
    const marked = body.length > 0 ? extractMarkedSummary(body) : null;
    let catalog;
    if (marked !== null) {
        requirePriorityCategories(body, marked);
        catalog = catalogWithLink(marked, repo, tag);
    } else if (body.length > 0) {
        catalog = catalogWithLink(body, repo, tag);
        assertCatalogBudget(
            catalog,
            `pre-drafted notes need ${SUMMARY_START} and ${SUMMARY_END} around a concise catalog summary`
        );
    } else {
        catalog = selectCommitSummary(commits, repo, tag);
    }
    assertCatalogBudget(catalog, 'catalog summary');
    return { catalog, fullNotes };
}

function parseArgs(argv) {
    const options = {};
    const allowed = new Set([
        'catalog-output',
        'commit-subjects-file',
        'draft-json',
        'first-release',
        'full-output',
        'repo',
        'tag',
    ]);
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        const key = flag?.startsWith('--') ? flag.slice(2) : '';
        const value = argv[i + 1];
        if (!allowed.has(key) || value === undefined || value.startsWith('--')) {
            throw new ReleaseNotesError(`unknown option or invalid value: ${flag ?? '<missing>'}`);
        }
        if (options[key] !== undefined) throw new ReleaseNotesError(`duplicate option: --${key}`);
        options[key] = value;
    }
    for (const required of ['repo', 'tag', 'commit-subjects-file', 'full-output', 'catalog-output', 'first-release']) {
        if (!options[required]) throw new ReleaseNotesError(`--${required} is required`);
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new ReleaseNotesError('--repo must be owner/name');
    if (!['true', 'false'].includes(options['first-release'])) {
        throw new ReleaseNotesError('--first-release must be true or false');
    }
    return options;
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const commits = fs.readFileSync(options['commit-subjects-file'], 'utf8').split('\n');
        let draftBody = '';
        if (options['draft-json']) {
            const release = JSON.parse(fs.readFileSync(options['draft-json'], 'utf8'));
            if (release.body !== null && release.body !== undefined && typeof release.body !== 'string') {
                throw new ReleaseNotesError('draft release body must be a string or null');
            }
            draftBody = release.body || '';
        }
        const prepared = prepareReleaseNotes({
            repo: options.repo,
            tag: options.tag,
            draftBody,
            commitSubjects: commits,
            firstRelease: options['first-release'] === 'true',
        });
        fs.writeFileSync(options['full-output'], `${prepared.fullNotes}\n`);
        fs.writeFileSync(options['catalog-output'], `${prepared.catalog}\n`);
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    ReleaseNotesError,
    SUMMARY_END,
    SUMMARY_START,
    extractMarkedSummary,
    prepareReleaseNotes,
};
