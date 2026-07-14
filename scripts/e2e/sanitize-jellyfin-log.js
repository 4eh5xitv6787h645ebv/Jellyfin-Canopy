#!/usr/bin/env node

// @ts-check
'use strict';

const fs = require('node:fs');

const REDACTED = '<redacted>';

// Jellyfin authentication material appears in both request-shaped diagnostics
// and serialized header objects. API keys are also present in service config
// objects (for example SeerrApiKey and TMDB_API_KEY), so match any field ending
// in ApiKey rather than maintaining a list that can silently fall behind.
const API_KEY_SOURCE = String.raw`(?:[A-Za-z0-9_-]*api[-_]?key)`;
const SENSITIVE_KEY_SOURCE = String.raw`(?:X-MediaBrowser-Token|X-Emby-Token|${API_KEY_SOURCE}|access[-_]?token|auth[-_]?token|token)`;
const AUTHORIZATION_KEY_SOURCE = String.raw`(?:Authorization|X-Emby-Authorization|X-MediaBrowser-Authorization)`;

// Accept ordinary object/header keys, escaped JSON keys, accessor notation such
// as headers["Authorization"], and empty-bracket query keys such as api_key[].
const KEY_SUFFIX_SOURCE = String.raw`(?:\\?["'])?\s*(?:\]\s*)?(?:\[\s*\]\s*)?`;
const SENSITIVE_ASSIGNMENT_PREFIX_SOURCE = String.raw`\b${SENSITIVE_KEY_SOURCE}\b${KEY_SUFFIX_SOURCE}(?:=|:)\s*`;
const AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE = String.raw`\b${AUTHORIZATION_KEY_SOURCE}\b${KEY_SUFFIX_SOURCE}(?:=|:)\s*`;

const LOGOUT_ACCESS_TOKEN = /(\bLogging out access token\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi;

// Redact the whole contents of array/bracket-wrapped sensitive values. This is
// deliberately before scalar assignments so JSON arrays and diagnostic forms
// such as Token: [secret] cannot expose a second value.
const SENSITIVE_ARRAY_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})(\[)([^\]\r\n]*)(\])`,
    'gi'
);
const AUTHORIZATION_ARRAY_ASSIGNMENT = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})(\[)([^\]\r\n]*)(\])`,
    'gi'
);

// Handle escaped quotes first. This is the shape emitted when a serialized
// header value (for example MediaBrowser Token=\"...\") is itself logged inside
// a quoted string.
const ESCAPED_DOUBLE_QUOTED_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})\\"[^"\r\n]*\\"`,
    'gi'
);
const ESCAPED_SINGLE_QUOTED_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})\\'[^'\r\n]*\\'`,
    'gi'
);
const DOUBLE_QUOTED_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})"[^"\r\n]*"`,
    'gi'
);
const SINGLE_QUOTED_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})'[^'\r\n]*'`,
    'gi'
);
const UNQUOTED_ASSIGNMENT = new RegExp(
    String.raw`(${SENSITIVE_ASSIGNMENT_PREFIX_SOURCE})(?!["'\\\[])[^\s,;&#}"'\]\r\n]+`,
    'gi'
);

const ESCAPED_DOUBLE_QUOTED_AUTHORIZATION = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})\\"([^"\r\n]*)\\"`,
    'gi'
);
const ESCAPED_SINGLE_QUOTED_AUTHORIZATION = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})\\'([^'\r\n]*)\\'`,
    'gi'
);
const DOUBLE_QUOTED_AUTHORIZATION = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})"((?:\\.|[^"\\\r\n])*)"`,
    'gi'
);
const SINGLE_QUOTED_AUTHORIZATION = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})'((?:\\.|[^'\\\r\n])*)'`,
    'gi'
);
const ESCAPED_DOUBLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE}(?:Bearer|Basic|Token|api[-_]?key)\s+)\\"[^"\r\n]*\\"`,
    'gi'
);
const ESCAPED_SINGLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE}(?:Bearer|Basic|Token|api[-_]?key)\s+)\\'[^'\r\n]*\\'`,
    'gi'
);
const DOUBLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE}(?:Bearer|Basic|Token|api[-_]?key)\s+)"[^"\r\n]*"`,
    'gi'
);
const SINGLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE}(?:Bearer|Basic|Token|api[-_]?key)\s+)'[^'\r\n]*'`,
    'gi'
);
const AUTHORIZATION_SCHEME_CREDENTIAL = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE}(?:\\?["'])?\s*(?:Bearer|Basic|Token|api[-_]?key)\s+)(?!["'\\\[])[^\s,;#}"'\\\]\r\n]+`,
    'gi'
);
const UNQUOTED_AUTHORIZATION = new RegExp(
    String.raw`(${AUTHORIZATION_ASSIGNMENT_PREFIX_SOURCE})(?!["'\\\[])([^\s,;#}"'\\\]\r\n]+)`,
    'gi'
);

/**
 * Redact an Authorization value while retaining the authentication scheme. A
 * MediaBrowser/Emby value is kept because its Token/ApiKey parameters were
 * already sanitized by the assignment passes above; client and device fields
 * remain valuable when diagnosing a logout race.
 *
 * @param {string} value
 */
function sanitizeAuthorizationValue(value) {
    const scheme = value.match(/^(\s*)(Bearer|Basic|Token|api[-_]?key)(\s+).+$/i);
    if (scheme) {
        return `${scheme[1]}${scheme[2]}${scheme[3]}${REDACTED}`;
    }
    if (/^\s*(?:MediaBrowser|Emby)\b/i.test(value)) {
        return value;
    }
    return REDACTED;
}

/**
 * Sanitize a bracket/array value while retaining whitespace and a single
 * scalar's quote style. Multiple array entries are collapsed to one redaction,
 * ensuring an unexpected second credential cannot pass through.
 *
 * @param {string} content
 * @param {(value: string) => string} sanitizeValue
 */
function sanitizeArrayContent(content, sanitizeValue) {
    const leading = content.match(/^\s*/)?.[0] ?? '';
    const trailing = content.match(/\s*$/)?.[0] ?? '';
    const core = content.slice(leading.length, content.length - trailing.length);

    if (core.length === 0) {
        return content;
    }

    const quotedForms = [
        { match: core.match(/^\\"((?:\\.|[^"\\])*)\\"$/), quote: '\\"' },
        { match: core.match(/^\\'((?:\\.|[^'\\])*)\\'$/), quote: "\\'" },
        { match: core.match(/^"((?:\\.|[^"\\])*)"$/), quote: '"' },
        { match: core.match(/^'((?:\\.|[^'\\])*)'$/), quote: "'" },
    ];
    const quoted = quotedForms.find(({ match }) => match !== null);
    if (quoted?.match) {
        return `${leading}${quoted.quote}${sanitizeValue(quoted.match[1])}${quoted.quote}${trailing}`;
    }

    return `${leading}${sanitizeValue(core)}${trailing}`;
}

/**
 * Remove known Jellyfin authentication secrets from Docker/server log text.
 * The transformation is deterministic and preserves all line endings so the
 * result can be printed directly as CI diagnostic evidence.
 *
 * @param {unknown} input
 * @returns {string}
 */
function sanitizeJellyfinLog(input) {
    let output = String(input == null ? '' : input);

    output = output.replace(LOGOUT_ACCESS_TOKEN, `$1"${REDACTED}"`);

    output = output.replace(
        SENSITIVE_ARRAY_ASSIGNMENT,
        (_match, prefix, openingBracket, content, closingBracket) => (
            `${prefix}${openingBracket}${sanitizeArrayContent(content, () => REDACTED)}${closingBracket}`
        )
    );

    output = output.replace(ESCAPED_DOUBLE_QUOTED_ASSIGNMENT, `$1\\"${REDACTED}\\"`);
    output = output.replace(ESCAPED_SINGLE_QUOTED_ASSIGNMENT, `$1\\'${REDACTED}\\'`);
    output = output.replace(DOUBLE_QUOTED_ASSIGNMENT, `$1"${REDACTED}"`);
    output = output.replace(SINGLE_QUOTED_ASSIGNMENT, `$1'${REDACTED}'`);
    output = output.replace(UNQUOTED_ASSIGNMENT, `$1${REDACTED}`);

    output = output.replace(
        AUTHORIZATION_ARRAY_ASSIGNMENT,
        (_match, prefix, openingBracket, content, closingBracket) => (
            `${prefix}${openingBracket}`
                + `${sanitizeArrayContent(content, sanitizeAuthorizationValue)}${closingBracket}`
        )
    );

    output = output.replace(
        ESCAPED_DOUBLE_QUOTED_AUTHORIZATION,
        (_match, prefix, value) => `${prefix}\\"${sanitizeAuthorizationValue(value)}\\"`
    );
    output = output.replace(
        ESCAPED_SINGLE_QUOTED_AUTHORIZATION,
        (_match, prefix, value) => `${prefix}\\'${sanitizeAuthorizationValue(value)}\\'`
    );
    output = output.replace(
        DOUBLE_QUOTED_AUTHORIZATION,
        (_match, prefix, value) => `${prefix}"${sanitizeAuthorizationValue(value)}"`
    );
    output = output.replace(
        SINGLE_QUOTED_AUTHORIZATION,
        (_match, prefix, value) => `${prefix}'${sanitizeAuthorizationValue(value)}'`
    );
    output = output.replace(
        ESCAPED_DOUBLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL,
        `$1\\"${REDACTED}\\"`
    );
    output = output.replace(
        ESCAPED_SINGLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL,
        `$1\\'${REDACTED}\\'`
    );
    output = output.replace(
        DOUBLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL,
        `$1"${REDACTED}"`
    );
    output = output.replace(
        SINGLE_QUOTED_AUTHORIZATION_SCHEME_CREDENTIAL,
        `$1'${REDACTED}'`
    );
    output = output.replace(AUTHORIZATION_SCHEME_CREDENTIAL, `$1${REDACTED}`);
    output = output.replace(UNQUOTED_AUTHORIZATION, (match, prefix, firstWord) => {
        if (/^(?:MediaBrowser|Emby|Bearer|Basic|Token|api[-_]?key)$/i.test(firstWord)) {
            return match;
        }
        return `${prefix}${REDACTED}`;
    });

    return output;
}

function runCli() {
    try {
        const input = fs.readFileSync(0, 'utf8');
        process.stdout.write(sanitizeJellyfinLog(input));
    } catch {
        // Never include the input or exception detail: either could itself carry
        // the credential this safety boundary exists to suppress.
        console.error('Could not sanitize Jellyfin log input.');
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runCli();
}

module.exports = {
    REDACTED,
    sanitizeJellyfinLog,
};
