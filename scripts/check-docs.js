'use strict';

const { spawnSync } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('yaml');
const {
    checkMarkdownLinks,
    collectMarkdownFiles,
    extractLinks,
} = require('./check-markdown-links');

const ROOT = path.join(__dirname, '..');
const POLICY_FILE = path.join(__dirname, 'docs-external-links.json');
const markdown = new MarkdownIt({ html: true });
const SUPPORTED_FENCES = new Set(['bash', 'http', 'json', 'shell', 'sh', 'yaml', 'yml']);
const DEAD_STATUSES = new Set([404, 410]);
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(api[_-]?key|auth|credential|key|password|secret|signature|token)(?:$|[_-])/i;
const REDACTED_MALFORMED_URL = '<redacted-malformed-url>';
const ABSOLUTE_HTTP_TARGET = /^https?:\/\/[^/?#\\\s]+(?:[/?][^#\\\s]*)?$/i;
const ABSOLUTE_EXTERNAL_URL = /^https?:\/\/[^/?#\\\s]+(?:[/?#][^\\]*)?$/i;

class ExampleValidationError extends Error {
    constructor(message, line = 1) {
        super(message);
        this.line = line;
    }
}

function documentationFiles(root = ROOT) {
    return collectMarkdownFiles(root).sort();
}

function fenceLanguage(info) {
    return info.trim().split(/\s+/, 1)[0].toLowerCase();
}

function jsonErrorLine(error, source) {
    const explicit = error.message.match(/line\s+(\d+)/i)?.[1];
    if (explicit) return Number(explicit);
    const position = error.message.match(/position\s+(\d+)/i)?.[1];
    if (position) return source.slice(0, Number(position)).split('\n').length;
    const unexpected = error.message.match(/^Unexpected token '([^']+)'/)?.[1];
    if (unexpected) {
        const offset = source.lastIndexOf(unexpected);
        if (offset >= 0) return source.slice(0, offset).split('\n').length;
    }
    return 1;
}

function parseJsonExample(source, lineOffset = 0) {
    try {
        JSON.parse(source);
    } catch (error) {
        throw new ExampleValidationError('invalid JSON syntax', lineOffset + jsonErrorLine(error, source));
    }
}

function safeHttpTarget(target) {
    if (ABSOLUTE_HTTP_TARGET.test(target)) return sanitizeExternalUrl(target);
    if (target.startsWith('/')) return target.replace(/[?#].*$/, '');
    return '<redacted-invalid-target>';
}

function validateRequestTarget(target) {
    if (/^\/(?!\/)/.test(target)) {
        if (target.includes('#') || target.includes('\\')) {
            throw new Error(`invalid origin-form request target: ${safeHttpTarget(target)}`);
        }
        return;
    }
    if (!ABSOLUTE_HTTP_TARGET.test(target)) {
        throw new Error(`request target must be origin-form or absolute HTTP(S): ${safeHttpTarget(target)}`);
    }
    let url;
    try {
        url = new URL(target);
    } catch {
        throw new Error(`request target must be origin-form or absolute HTTP(S): ${safeHttpTarget(target)}`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
        throw new Error(`request target must be origin-form or absolute HTTP(S): ${safeHttpTarget(target)}`);
    }
}

function validateHttpExample(source) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const requestPattern = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+?)(?:\s+HTTP\/(?:1\.[01]|2))?\s*$/;
    const requests = [];
    let current = null;
    let bodyStarted = false;

    const finish = () => {
        if (!current) return;
        const contentType = current.headers.find(header => header.name.toLowerCase() === 'content-type');
        const body = current.body.map(entry => entry.value).join('\n').trim();
        const mediaType = contentType?.value.split(';', 1)[0].trim().toLowerCase() || '';
        const isJson = mediaType === 'application/json'
            || /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/.test(mediaType);
        if (mediaType.includes('json') && !isJson) {
            throw new ExampleValidationError('unsupported JSON-like media type', contentType.line);
        }
        if (isJson && body) {
            const firstBodyLine = current.body.find(entry => entry.value.trim())?.line || current.requestLine;
            parseJsonExample(body, firstBodyLine - 1);
        }
        requests.push(current);
        current = null;
        bodyStarted = false;
    };

    for (const [index, line] of lines.entries()) {
        const lineNumber = index + 1;
        const request = line.match(requestPattern);
        if (request) {
            finish();
            const target = request[2];
            try {
                validateRequestTarget(target);
            } catch (error) {
                throw new ExampleValidationError(error.message, lineNumber);
            }
            current = { method: request[1], target, requestLine: lineNumber, headers: [], body: [] };
            continue;
        }
        if (!current) {
            if (line.trim()) throw new ExampleValidationError('expected an HTTP request line', lineNumber);
            continue;
        }
        if (!bodyStarted && !line.trim()) {
            bodyStarted = true;
            continue;
        }
        if (!bodyStarted) {
            const header = line.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.*)$/);
            if (!header) throw new ExampleValidationError('invalid HTTP header', lineNumber);
            current.headers.push({ name: header[1], value: header[2], line: lineNumber });
            continue;
        }
        current.body.push({ value: line, line: lineNumber });
    }
    finish();
    if (requests.length === 0) throw new ExampleValidationError('example contains no HTTP request');
}

function validateFence(language, source) {
    if (language === 'json') {
        parseJsonExample(source);
        return;
    }
    if (language === 'yaml' || language === 'yml') {
        const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
        if (document.errors.length > 0) {
            const error = document.errors[0];
            const line = error.linePos?.[0]?.line
                || (Number.isInteger(error.pos?.[0]) ? source.slice(0, error.pos[0]).split('\n').length : 1);
            throw new ExampleValidationError('invalid YAML syntax', line);
        }
        return;
    }
    if (language === 'bash' || language === 'shell' || language === 'sh') {
        const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            const stderr = result.stderr || '';
            const reported = Number(stderr.match(/(?:line |stdin:)(\d+)/i)?.[1] || 1);
            const contentLines = source.replace(/\n$/, '').split('\n').length;
            const line = Math.min(reported, contentLines);
            throw new ExampleValidationError('bash syntax check failed', line);
        }
        return;
    }
    if (language === 'http') validateHttpExample(source);
}

function validateExamplesInFile(file, root = ROOT) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const problems = [];
    for (const token of markdown.parse(source, {})) {
        if (token.type !== 'fence') continue;
        const language = fenceLanguage(token.info);
        if (!SUPPORTED_FENCES.has(language)) continue;
        try {
            validateFence(language, token.content);
        } catch (error) {
            const relativeLine = Number.isInteger(error.line) ? error.line : 1;
            const line = (token.map?.[0] ?? 0) + 1 + relativeLine;
            problems.push(`${file}:${line}: invalid ${language} example: ${error.message}`);
        }
    }
    return problems;
}

function sanitizeExternalUrl(rawUrl) {
    if (/^https?:/i.test(rawUrl) && !ABSOLUTE_EXTERNAL_URL.test(rawUrl)) {
        return REDACTED_MALFORMED_URL;
    }
    try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
    } catch {
        return REDACTED_MALFORMED_URL;
    }
}

function ipv4Value(address) {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}

function ipv6Value(address) {
    let normalized = address.toLowerCase();
    const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (ipv4Tail) {
        const value = ipv4Value(ipv4Tail);
        if (value === null) return null;
        normalized = normalized.slice(0, -ipv4Tail.length)
            + `${Number((value >> 16n) & 0xffffn).toString(16)}:${Number(value & 0xffffn).toString(16)}`;
    }
    if ((normalized.match(/::/g) || []).length > 1) return null;
    const [leftText, rightText] = normalized.split('::');
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((!normalized.includes('::') && missing !== 0) || (normalized.includes('::') && missing < 1)) return null;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function inCidr(value, network, prefix, bits) {
    const shift = BigInt(bits - prefix);
    return (value >> shift) === (network >> shift);
}

const IPV4_NON_PUBLIC = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, prefix]) => [ipv4Value(address), prefix]);
const IPV6_NON_PUBLIC = [
    ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].map(([address, prefix]) => [ipv6Value(address), prefix]);
const IPV4_MAPPED_NETWORK = ipv6Value('::ffff:0:0');

function isPublicIpAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const value = ipv4Value(address);
        return !IPV4_NON_PUBLIC.some(([network, prefix]) => inCidr(value, network, prefix, 32));
    }
    if (family === 6) {
        const value = ipv6Value(address);
        if (inCidr(value, IPV4_MAPPED_NETWORK, 96, 128)) {
            const mapped = [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 0xffn)).join('.');
            return isPublicIpAddress(mapped);
        }
        return !IPV6_NON_PUBLIC.some(([network, prefix]) => inCidr(value, network, prefix, 128));
    }
    return false;
}

function isPrivateHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
        return true;
    }
    return net.isIP(normalized) !== 0 && !isPublicIpAddress(normalized);
}

function externalUrlProblem(rawUrl, policyUrls) {
    if (/^https?:/i.test(rawUrl) && !ABSOLUTE_EXTERNAL_URL.test(rawUrl)) {
        return `malformed external URL: ${REDACTED_MALFORMED_URL}`;
    }
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return `malformed external URL: ${sanitizeExternalUrl(rawUrl)}`;
    }
    const safe = sanitizeExternalUrl(rawUrl);
    if (url.protocol !== 'https:') return `external documentation URL must use HTTPS: ${safe}`;
    if (url.username || url.password || [...url.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key))) {
        return `external URL contains credentials or sensitive query data: ${safe}`;
    }
    if (isPrivateHostname(url.hostname)) return `private network URL cannot be published or probed: ${safe}`;
    if (/\/Jellyfin-(?:Canopy|Elevate)(?:\/|$)/i.test(url.pathname)) {
        const projectPath = `/4eh5xitv6787h645ebv/Jellyfin-Canopy`;
        const canonicalRepository = url.hostname === 'github.com' && url.pathname.startsWith(projectPath);
        const canonicalPages = url.hostname === '4eh5xitv6787h645ebv.github.io'
            && url.pathname.startsWith('/Jellyfin-Canopy');
        if (!canonicalRepository && !canonicalPages) {
            return `project-owned link points outside the canonical repository: ${safe}`;
        }
    }
    if (!policyUrls.has(rawUrl)) return `external URL is absent from the reviewed offline inventory: ${safe}`;
    return '';
}

function externalLinksInMarkdown(file, root = ROOT) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return extractLinks(source)
        .filter(link => /^(?:https?:)?\/\//i.test(link.target || ''))
        .map(link => ({ file, line: link.line, url: link.target.startsWith('//') ? `https:${link.target}` : link.target }));
}

function externalLinksInMkdocs(root = ROOT) {
    const file = 'mkdocs.yml';
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const links = [];
    for (const [index, line] of source.split('\n').entries()) {
        for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) {
            links.push({ file, line: index + 1, url: match[0] });
        }
    }
    return links;
}

function themeSourceFiles(root = ROOT) {
    const themeRoot = path.join(root, 'theme');
    if (!fs.existsSync(themeRoot)) return [];
    const files = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (/\.(?:css|html?)$/i.test(entry.name)) files.push(path.relative(root, full));
        }
    };
    visit(themeRoot);
    return files.sort();
}

function sourceLine(source, offset) {
    return source.slice(0, offset).split('\n').length;
}

function htmlAttributeMap(tag) {
    const attributes = new Map();
    const pattern = /\b([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gis;
    for (const match of tag.matchAll(pattern)) {
        const name = match[1].toLowerCase();
        if (attributes.has(name)) continue;
        attributes.set(name, {
            value: match[2] ?? match[3] ?? match[4],
            offset: match.index,
        });
    }
    return attributes;
}

function refreshTarget(content) {
    const match = content.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/i);
    return match ? (match[1] ?? match[2] ?? match[3]).trim() : '';
}

function externalLinksInTheme(root = ROOT) {
    const links = [];
    for (const file of themeSourceFiles(root)) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const candidates = [];
        const addCssCandidates = () => {
            const cssUrl = /(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)'))/gi;
            for (const match of source.matchAll(cssUrl)) {
                candidates.push([match.slice(1).find(value => value !== undefined), match.index]);
            }
        };
        if (/\.html?$/i.test(file)) {
            const attribute = /\b(action|cite|content|data|formaction|href|poster|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gis;
            for (const match of source.matchAll(attribute)) {
                const values = match[1].toLowerCase() === 'srcset'
                    ? (match[2] || match[3] || match[4]).split(',').map(value => value.trim().split(/\s+/, 1)[0])
                    : [match[2] || match[3] || match[4]];
                for (const value of values) candidates.push([value, match.index]);
            }
            for (const meta of source.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gis)) {
                const attributes = htmlAttributeMap(meta[0]);
                const httpEquiv = attributes.get('http-equiv');
                if (!httpEquiv
                    || markdown.utils.unescapeAll(httpEquiv.value).trim().toLowerCase() !== 'refresh') continue;
                const content = attributes.get('content');
                if (!content) continue;
                const target = refreshTarget(markdown.utils.unescapeAll(content.value));
                if (target) candidates.push([target, meta.index + content.offset]);
            }
            addCssCandidates();
        } else {
            addCssCandidates();
        }
        for (const [rawTarget, offset] of candidates) {
            const target = markdown.utils.unescapeAll(rawTarget);
            if (!/^(?:https?:)?\/\//i.test(target)) continue;
            links.push({
                file,
                line: sourceLine(source, offset),
                url: target.startsWith('//') ? `https:${target}` : target,
            });
        }
    }
    return links;
}

function externalLinkInventory(root = ROOT) {
    const links = documentationFiles(root).flatMap(file => externalLinksInMarkdown(file, root));
    links.push(...externalLinksInMkdocs(root));
    links.push(...externalLinksInTheme(root));
    return links.sort((left, right) => (
        left.url.localeCompare(right.url) || left.file.localeCompare(right.file) || left.line - right.line
    ));
}

function loadExternalPolicy(policyFile = POLICY_FILE) {
    let policy;
    try {
        policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    } catch {
        throw new Error('docs external-link policy is not valid JSON');
    }
    if (policy.schemaVersion !== 1 || !Array.isArray(policy.allowedUrls)) {
        throw new Error('docs external-link policy must use schemaVersion 1 and allowedUrls[]');
    }
    const urls = new Set();
    for (const entry of policy.allowedUrls) {
        if (!entry || typeof entry.url !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw new Error('every allowed external URL requires a url and non-empty reason');
        }
        if (entry.probe !== undefined && entry.probe !== 'dns-only') {
            throw new Error('external URL probe mode must be dns-only when specified');
        }
        if (urls.has(entry.url)) {
            throw new Error(`duplicate external URL policy entry: ${sanitizeExternalUrl(entry.url)}`);
        }
        urls.add(entry.url);
    }
    return { policy, urls };
}

function classifyProbeAttempts(attempts) {
    if (attempts.some(attempt => attempt.blocked)) return 'blocked';
    if (attempts.some(attempt => (
        Number.isInteger(attempt.status)
        && attempt.status >= 200 && attempt.status < 400
    ))) return 'reachable';
    if (attempts.length >= 2 && attempts.every(attempt => DEAD_STATUSES.has(attempt.status))) return 'confirmed-dead';
    return 'transient';
}

function isPolicyBlock(message) {
    return /malformed external URL|absent from the reviewed|must use HTTPS|credentials or sensitive|private network|non-public address|outside the canonical/.test(message);
}

function boundedLookup(hostname, lookupImpl, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error('DNS lookup timed out');
            error.name = 'TimeoutError';
            reject(error);
        }, timeoutMs);
        Promise.resolve()
            .then(() => lookupImpl(hostname, { all: true, verbatim: true }))
            .then(
                result => { clearTimeout(timer); resolve(result); },
                error => { clearTimeout(timer); reject(error); }
            );
    });
}

async function validateProbeTarget(rawUrl, policyUrls, lookupImpl, timeoutMs) {
    const problem = externalUrlProblem(rawUrl, policyUrls);
    if (problem) throw new Error(problem);
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
    else addresses = await boundedLookup(hostname, lookupImpl, timeoutMs);
    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new Error(`DNS returned no addresses for ${sanitizeExternalUrl(rawUrl)}`);
    }
    if (addresses.some(result => !isPublicIpAddress(result.address))) {
        throw new Error(`DNS resolved to a non-public address for ${sanitizeExternalUrl(rawUrl)}`);
    }
    return { url, addresses };
}

function secureHttpsRequest(url, options, addresses) {
    return new Promise((resolve, reject) => {
        let nextAddress = 0;
        const lookup = (_hostname, lookupOptions, callback) => {
            if (lookupOptions?.all) {
                callback(null, addresses.map(result => ({ address: result.address, family: result.family })));
                return;
            }
            const result = addresses[nextAddress++ % addresses.length];
            callback(null, result.address, result.family);
        };
        const request = https.request(url, {
            method: options.method,
            headers: options.headers,
            signal: options.signal,
            agent: false,
            lookup,
        }, response => resolve({
            status: response.statusCode || 0,
            headers: { get: name => response.headers[name.toLowerCase()] || null },
            body: { cancel: async () => response.destroy() },
        }));
        request.on('error', reject);
        request.end();
    });
}

async function cancelResponseBody(response) {
    if (response?.body && typeof response.body.cancel === 'function') {
        try {
            await response.body.cancel();
        } catch {
            // The bounded audit deliberately consumes no response body.
        }
    }
}

async function fetchProbeChain(
    initialUrl,
    { fetchImpl, lookupImpl, policyUrls, timeoutMs, maxRedirects, method = 'HEAD' }
) {
    let current = initialUrl;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const { addresses } = await validateProbeTarget(current, policyUrls, lookupImpl, timeoutMs);
        const options = {
            method,
            headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
            redirect: 'manual',
            signal: globalThis.AbortSignal.timeout(timeoutMs),
        };
        const response = fetchImpl
            ? await fetchImpl(current, options)
            : await secureHttpsRequest(current, options, addresses);
        if (response.status < 300 || response.status >= 400) return { response, url: current };
        const location = response.headers?.get?.('location');
        await cancelResponseBody(response);
        if (!location) throw new Error(`redirect has no Location header for ${sanitizeExternalUrl(current)}`);
        if (redirects === maxRedirects) throw new Error(`redirect limit exceeded for ${sanitizeExternalUrl(current)}`);
        try {
            current = new URL(location, current).href;
        } catch {
            throw new Error(`redirect has a malformed target for ${sanitizeExternalUrl(current)}`);
        }
        // The next loop validates both inventory membership and every resolved
        // address before the redirected target can reach fetch().
    }
    throw new Error('unreachable redirect state');
}

async function probeExternalUrl(
    url,
    {
        fetchImpl = null,
        lookupImpl = dns.lookup,
        policyUrls = new Set(),
        maxAttempts = 2,
        maxRedirects = 3,
        timeoutMs = 5_000,
    } = {}
) {
    const attempts = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            let { response, url: finalUrl } = await fetchProbeChain(url, {
                fetchImpl, lookupImpl, policyUrls, timeoutMs, maxRedirects, method: 'HEAD',
            });
            if (DEAD_STATUSES.has(response.status) || response.status === 405 || response.status === 501) {
                await cancelResponseBody(response);
                ({ response, url: finalUrl } = await fetchProbeChain(finalUrl, {
                    fetchImpl, lookupImpl, policyUrls, timeoutMs, maxRedirects, method: 'GET',
                }));
            }
            attempts.push({ status: response.status });
            await cancelResponseBody(response);
            if (classifyProbeAttempts(attempts) === 'reachable') break;
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const blocked = isPolicyBlock(message);
            attempts.push(blocked ? { blocked: true } : { error: error instanceof Error ? error.name : 'network-error' });
            if (blocked) break;
        }
    }
    return { attempts, classification: classifyProbeAttempts(attempts) };
}

async function probeExternalEntry(entry, policyUrls, options = {}) {
    if (entry.probe !== 'dns-only') return probeExternalUrl(entry.url, { ...options, policyUrls });
    const attempts = [];
    const maxAttempts = options.maxAttempts ?? 2;
    const timeoutMs = options.timeoutMs ?? 5_000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            await validateProbeTarget(
                entry.url,
                policyUrls,
                options.lookupImpl || dns.lookup,
                timeoutMs
            );
            attempts.push({ dnsOnly: true });
            return { attempts, classification: 'reachable' };
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const blocked = isPolicyBlock(message);
            attempts.push(blocked
                ? { blocked: true }
                : { error: error instanceof Error ? error.name : 'network-error' });
            if (blocked) break;
        }
    }
    return { attempts, classification: classifyProbeAttempts(attempts) };
}

function checkDocumentation({ root = ROOT, policyFile = POLICY_FILE } = {}) {
    const files = documentationFiles(root);
    const problems = checkMarkdownLinks(files, root);
    problems.push(...files.flatMap(file => validateExamplesInFile(file, root)));
    const { policy, urls } = loadExternalPolicy(policyFile);
    for (const link of externalLinkInventory(root)) {
        const problem = externalUrlProblem(link.url, urls);
        if (problem) problems.push(`${link.file}:${link.line}: ${problem}`);
    }
    const used = new Set(externalLinkInventory(root).map(link => link.url));
    for (const entry of policy.allowedUrls) {
        if (!used.has(entry.url)) problems.push(`external URL policy has an unused entry: ${sanitizeExternalUrl(entry.url)}`);
    }
    return { files, externalUrls: used, problems };
}

async function probePolicy(policyFile = POLICY_FILE) {
    const { policy, urls } = loadExternalPolicy(policyFile);
    const locations = new Map();
    for (const link of externalLinkInventory()) {
        const existing = locations.get(link.url) || [];
        existing.push(`${link.file}:${link.line}`);
        locations.set(link.url, existing);
    }
    const results = [];
    for (const entry of policy.allowedUrls) {
        const result = await probeExternalEntry(entry, urls);
        results.push({ url: entry.url, locations: locations.get(entry.url) || [], ...result });
    }
    return results;
}

async function main() {
    if (process.argv.includes('--print-external-inventory')) {
        for (const url of new Set(externalLinkInventory().map(link => link.url))) {
            console.log(sanitizeExternalUrl(url));
        }
        return;
    }
    if (process.argv.includes('--probe-external')) {
        const results = await probePolicy();
        for (const result of results) {
            console.log(
                `${result.classification}: ${result.locations.join(',') || 'policy-only'}: `
                + sanitizeExternalUrl(result.url)
            );
        }
        if (results.some(result => ['blocked', 'confirmed-dead'].includes(result.classification))) process.exitCode = 1;
        else if (results.some(result => result.classification === 'transient')) process.exitCode = 2;
        return;
    }
    const result = checkDocumentation();
    if (result.problems.length > 0) {
        console.error(`Documentation validation failed:\n${result.problems.map(problem => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    console.log(
        `Documentation content OK: ${result.files.length} files, ${result.externalUrls.size} reviewed external URLs; `
        + 'reachability is intentionally offline in blocking CI'
    );
}

if (require.main === module) void main();

module.exports = {
    checkDocumentation,
    classifyProbeAttempts,
    documentationFiles,
    externalLinkInventory,
    externalLinksInTheme,
    externalUrlProblem,
    isPublicIpAddress,
    loadExternalPolicy,
    probeExternalUrl,
    probeExternalEntry,
    sanitizeExternalUrl,
    validateExamplesInFile,
    validateFence,
    validateHttpExample,
};
