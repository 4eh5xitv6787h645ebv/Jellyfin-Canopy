'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

const ROOT = path.join(__dirname, '..');
const REQUIRED_FILES = ['README.md', 'CONTRIBUTING.md'];
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.linkify.set({ fuzzyEmail: false, fuzzyLink: false });
const gfmWwwLinkifier = new MarkdownIt().linkify;
gfmWwwLinkifier.set({ fuzzyEmail: false });

function headingSlug(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
        .replace(/ /g, '-');
}

function mkdocsHeadingSlug(heading) {
    return heading
        .trim()
        .normalize('NFKD')
        .replace(/[^\p{ASCII}]/gu, '')
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/[-\s]+/g, '-');
}

function inlineText(children = []) {
    return children.map((token) => {
        if (['text', 'code_inline', 'html_inline'].includes(token.type)) {
            return token.content.replace(/<[^>]*>/g, '');
        }
        if (token.type === 'image') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
        return '';
    }).join('');
}

function stripHtmlComments(content) {
    let rendered = '';
    let offset = 0;
    while (offset < content.length) {
        const opening = content.indexOf('<!--', offset);
        if (opening === -1) return rendered + content.slice(offset);
        rendered += content.slice(offset, opening);
        const closing = content.indexOf('-->', opening + 4);
        if (closing === -1) return rendered;
        offset = closing + 3;
    }
    return rendered;
}

function htmlAttributeValue(tag, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
        'i'
    );
    const match = tag.match(pattern);
    return match ? markdown.utils.unescapeAll(match[1] ?? match[2] ?? match[3]) : '';
}

function stripHiddenHtml(content, hiddenTag = htmlTagIsHidden) {
    const source = stripHtmlComments(content);
    const visible = [];
    const stack = [];
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
        const hiddenBefore = Boolean(stack.at(-1)?.hidden);
        if (!hiddenBefore) visible.push(source.slice(offset, match.index));
        const closing = match[1] === '/';
        const ownHidden = !closing && hiddenTag(match[0]);
        updateHtmlVisibilityStack(stack, match[0], hiddenTag);
        const hiddenAfter = Boolean(stack.at(-1)?.hidden);
        if (closing
            ? !hiddenBefore && !hiddenAfter
            : !hiddenAfter && !ownHidden) {
            visible.push(match[0]);
        }
        offset = match.index + match[0].length;
    }
    if (!stack.at(-1)?.hidden) visible.push(source.slice(offset));
    return visible.join('');
}

function accessibleHtmlText(content, labels = new Map(), excludeAriaHidden = true) {
    const visible = stripHiddenHtml(
        content,
        tag => htmlTagIsHidden(tag) || excludeAriaHidden && htmlTagIsAriaHidden(tag)
    )
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(
            /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/svg\s*>/gi,
            (element, attributes, body) => {
                const openingTag = `<svg${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeValue(openingTag, 'aria-label')
                    || htmlAttributeValue(openingTag, 'title')
                    || accessibleHtmlText(body, labels, excludeAriaHidden);
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(/<svg\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/gi, (tag) => {
            const name = ariaLabelledText(tag, labels)
                || htmlAttributeValue(tag, 'aria-label')
                || htmlAttributeValue(tag, 'title');
            return name ? ` ${name} ` : ' ';
        })
        .replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
            const name = ariaLabelledText(tag, labels)
                || htmlAttributeValue(tag, 'aria-label')
                || htmlAttributeValue(tag, 'alt')
                || htmlAttributeValue(tag, 'title');
            return name ? ` ${name} ` : ' ';
        })
        .replace(
            /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*\saria-(?:label|labelledby)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi,
            (element, tag, attributes, body) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeValue(openingTag, 'aria-label')
                    || htmlAttributeValue(openingTag, 'title')
                    || accessibleHtmlText(body, labels, excludeAriaHidden);
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(
            /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*\saria-(?:label|labelledby)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi,
            (element, tag, attributes) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeValue(openingTag, 'aria-label')
                    || htmlAttributeValue(openingTag, 'title');
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(/<[^>]*>/g, ' ');
    return markdown.utils.unescapeAll(visible);
}

function visibleHtmlText(content, labels = new Map()) {
    return accessibleHtmlText(content, labels, false);
}

function visuallyRenderedHtmlText(content) {
    const visible = stripHiddenHtml(content)
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        // SVG title/description elements are metadata, but SVG <text> is
        // genuinely painted content and must remain available to route checks.
        .replace(/<(?:desc|title)\b[\s\S]*?<\/(?:desc|title)\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    return markdown.utils.unescapeAll(visible);
}

function combinedHtmlLabel(accessible, visual) {
    const accessibleLabel = accessible.replace(/\s+/g, ' ').trim();
    const visualLabel = visual.replace(/\s+/g, ' ').trim();
    if (!accessibleLabel) return visualLabel;
    if (!visualLabel || accessibleLabel.toLowerCase() === visualLabel.toLowerCase()) {
        return accessibleLabel;
    }
    return `${accessibleLabel} ${visualLabel}`;
}

function governedHtmlText(content, labels = new Map()) {
    return combinedHtmlLabel(
        accessibleHtmlText(content, labels),
        visuallyRenderedHtmlText(content)
    );
}

function governedInlineText(children = []) {
    const source = children.map((child) => {
        if (child.type === 'text' || child.type === 'code_inline') {
            return markdown.utils.escapeHtml(child.content);
        }
        if (child.type === 'image') return markdown.utils.escapeHtml(child.content);
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
        if (child.type === 'html_inline') return child.content;
        return '';
    }).join('');
    return governedHtmlText(source).replace(/\s+/g, ' ').trim();
}

function htmlAttributeRecords(content) {
    const attributes = [];
    const pattern = /(?:^|[\s<])(id|href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    for (const match of stripHtmlComments(content).matchAll(pattern)) {
        attributes.push({
            name: match[1].toLowerCase(),
            value: markdown.utils.unescapeAll(match[2] ?? match[3] ?? match[4]),
            index: match.index,
        });
    }
    return attributes;
}

function htmlAttributes(content) {
    return htmlAttributeRecords(content).map(({ name, value }) => ({ name, value }));
}

function htmlIds(tokens) {
    const ids = new Set();
    const visit = (token) => {
        if (token.type === 'html_block' || token.type === 'html_inline') {
            for (const attribute of htmlAttributes(token.content)) {
                if (attribute.name === 'id') ids.add(attribute.value);
            }
        }
        for (const child of token.children || []) visit(child);
    };
    for (const token of tokens) visit(token);
    return ids;
}

function addUniqueHeadingAnchor(anchors, base, dialect) {
    if (dialect === 'mkdocs' && base === '') {
        let suffix = 1;
        while (anchors.has(`_${suffix}`)) suffix += 1;
        anchors.add(`_${suffix}`);
        return `_${suffix}`;
    }
    if (!anchors.has(base)) {
        anchors.add(base);
        return base;
    }
    if (dialect === 'mkdocs') {
        const numbered = base.match(/^(.*)_([0-9]+)$/);
        const root = numbered ? numbered[1] : base;
        let suffix = numbered ? Number(numbered[2]) + 1 : 1;
        while (anchors.has(`${root}_${suffix}`)) suffix += 1;
        anchors.add(`${root}_${suffix}`);
        return `${root}_${suffix}`;
    }
    let suffix = 1;
    while (anchors.has(`${base}-${suffix}`)) suffix += 1;
    anchors.add(`${base}-${suffix}`);
    return `${base}-${suffix}`;
}

function mkdocsAttributeId(heading) {
    const attributes = heading.match(/\s*\{([^{}]*)\}\s*$/)?.[1];
    if (!attributes) return '';
    const assigned = attributes.match(/(?:^|\s)id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/);
    if (assigned) return assigned[1] || assigned[2] || assigned[3];
    return attributes.match(/(?:^|\s)#([^\s}]+)/)?.[1] || '';
}

function mkdocsBlockAttributeIds(tokens) {
    const ids = new Set();
    for (const token of tokens) {
        if (token.type !== 'inline') continue;
        const lines = token.content.split('\n');
        const attributeLine = lines.length - 1;
        if (attributeLine < 1 || !lines.slice(0, attributeLine).some(value => value.trim())) continue;
        const attributes = lines[attributeLine].match(/^\s*\{:\s*([^{}]*)\}\s*$/)?.[1];
        if (!attributes) continue;
        const id = mkdocsAttributeId(`{${attributes}}`);
        if (id) ids.add(id);
    }
    return ids;
}

function markdownHeadingAnchors(tokens, dialect = 'github') {
    const usedHeadingIds = dialect === 'mkdocs' ? mkdocsBlockAttributeIds(tokens) : new Set();
    const slug = dialect === 'mkdocs' ? mkdocsHeadingSlug : headingSlug;
    const headings = [];
    for (let index = 0; index < tokens.length - 1; index += 1) {
        if (tokens[index].type !== 'heading_open' || tokens[index + 1].type !== 'inline') continue;
        const heading = inlineText(tokens[index + 1].children);
        const explicitId = dialect === 'mkdocs' ? mkdocsAttributeId(heading) : '';
        headings.push({ explicitId, heading, index });
        if (explicitId) usedHeadingIds.add(explicitId);
    }
    const records = [];
    for (const record of headings) {
        let { heading } = record;
        if (record.explicitId) {
            records.push({ anchor: record.explicitId, index: record.index });
            continue;
        }
        if (dialect === 'mkdocs') heading = heading.replace(/\s*\{[^}]+\}\s*$/, '');
        records.push({
            anchor: addUniqueHeadingAnchor(usedHeadingIds, slug(heading), dialect),
            index: record.index,
        });
    }
    return records;
}

function markdownAnchors(source, dialect = 'github') {
    const tokens = markdown.parse(source, {});
    const anchors = htmlIds(tokens);
    const blockAttributeIds = dialect === 'mkdocs' ? mkdocsBlockAttributeIds(tokens) : new Set();
    for (const id of blockAttributeIds) anchors.add(id);
    for (const record of markdownHeadingAnchors(tokens, dialect)) anchors.add(record.anchor);
    return anchors;
}

function compactVisibleText(content, labels = new Map()) {
    return visibleHtmlText(content, labels).replace(/\s+/g, ' ').trim();
}

function htmlIdLabels(content) {
    const labels = new Map();
    const visible = stripHtmlComments(content);
    const opening = /<([a-z][a-z0-9:-]*)\b/gi;
    let match;
    while ((match = opening.exec(visible)) !== null) {
        const openingEnd = htmlOpeningTagEnd(visible, match.index);
        if (openingEnd === -1) break;
        const openingTag = visible.slice(match.index, openingEnd);
        const id = htmlAttributeValue(openingTag, 'id');
        if (!id || labels.has(id)) {
            opening.lastIndex = openingEnd;
            continue;
        }
        let label = htmlAttributeValue(openingTag, 'aria-label')
            || htmlAttributeValue(openingTag, 'title');
        if (!label && !/\/>\s*$/.test(openingTag)) {
            const closing = new RegExp(`</${match[1]}\\s*>`, 'ig');
            closing.lastIndex = openingEnd;
            const close = closing.exec(visible);
            if (close) label = compactVisibleText(visible.slice(openingEnd, close.index), labels);
        }
        if (label) labels.set(id, label.replace(/\s+/g, ' ').trim());
        opening.lastIndex = openingEnd;
    }
    return labels;
}

function ariaLabelledText(openingTag, labels) {
    return htmlAttributeValue(openingTag, 'aria-labelledby')
        .split(/\s+/)
        .filter(Boolean)
        .map(id => labels.get(id) || '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function htmlOpeningTagEnd(content, start) {
    let quote = '';
    for (let index = start; index < content.length; index += 1) {
        const character = content[index];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index + 1;
        }
    }
    return -1;
}

function htmlContextAfterBoundary(content) {
    const boundary = /<\/?(?:address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|td|th|tr|ul)\b(?:[^>"']|"[^"]*"|'[^']*')*>/i
        .exec(content);
    return boundary?.index ?? content.length;
}

function htmlContextBeforeBoundary(content) {
    let start = 0;
    for (const boundary of content.matchAll(
        /<\/?(?:address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|td|th|tr|ul)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
    )) {
        start = boundary.index + boundary[0].length;
    }
    return start;
}

const HTML_VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
]);

function htmlTagIsHidden(tag) {
    const style = htmlAttributeValue(tag, 'style');
    return /(?:^|\s)hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?(?=\s|\/?>)/i
        .test(tag)
        || inlineStyleHides(style);
}

function htmlTagIsAriaHidden(tag) {
    return htmlAttributeValue(tag, 'aria-hidden').toLowerCase() === 'true';
}

function cascadedInlineStyleValue(style, property, validValue) {
    let winner = null;
    const declaration = new RegExp(
        `(?:^|;)\\s*${property}\\s*:\\s*([^;]*)`,
        'gi'
    );
    for (const match of style.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(declaration)) {
        const important = /!\s*important\s*$/i.test(match[1]);
        const value = match[1].replace(/!\s*important\s*$/i, '').trim().toLowerCase();
        if (!validValue.test(value)) continue;
        if (!winner || important || !winner.important) winner = { important, value };
    }
    return winner?.value || '';
}

function inlineStyleHides(style) {
    const display = cascadedInlineStyleValue(
        style,
        'display',
        /^(?:none|contents|block|inline|run-in|flow-root|list-item|flex|grid|table|table-(?:row|cell|column|caption|row-group|header-group|footer-group|column-group)|inline-(?:block|flex|grid|table)|ruby(?:-base|-text|-base-container|-text-container)?|inherit|initial|revert(?:-layer)?|unset|(?:block|inline)\s+(?:flow|flow-root|flex|grid|ruby)(?:\s+list-item)?)$/i
    );
    const visibility = cascadedInlineStyleValue(
        style,
        'visibility',
        /^(?:visible|hidden|collapse|inherit|initial|revert(?:-layer)?|unset)$/i
    );
    return display === 'none' || ['hidden', 'collapse'].includes(visibility);
}

function updateHtmlVisibilityStack(stack, content, hiddenTag = htmlTagIsHidden) {
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    for (const match of content.matchAll(pattern)) {
        const closing = match[1] === '/';
        const tag = match[2].toLowerCase();
        if (closing) {
            const opening = stack.map(entry => entry.tag).lastIndexOf(tag);
            if (opening !== -1) stack.splice(opening);
            continue;
        }
        if (tag === 'a') {
            const activeAnchor = stack.map(entry => entry.tag).lastIndexOf(tag);
            if (activeAnchor !== -1) stack.splice(activeAnchor);
        }
        const selfClosing = /\/>\s*$/.test(match[0]) || HTML_VOID_ELEMENTS.has(tag);
        if (selfClosing) continue;
        stack.push({
            tag,
            hidden: Boolean(stack.at(-1)?.hidden) || hiddenTag(match[0]),
        });
    }
}

function htmlElementIsHidden(content, index, openingTag) {
    const stack = [];
    updateHtmlVisibilityStack(stack, content.slice(0, index));
    updateHtmlVisibilityStack(stack, openingTag);
    return Boolean(stack.at(-1)?.hidden);
}

function htmlPriorBlockText(content, boundary, labels) {
    if (boundary <= 0) return '';
    const blocks = content.slice(0, boundary).split(
        /<\/?(?:address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|td|th|tr|ul)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
    );
    return blocks.map(block => compactVisibleText(block, labels)).filter(Boolean).at(-1) || '';
}

function htmlAnchorHiddenStates(content) {
    const states = new Map();
    const stack = [];
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    for (const match of content.matchAll(pattern)) {
        updateHtmlVisibilityStack(stack, match[0]);
        if (match[1] !== '/' && match[2].toLowerCase() === 'a') {
            states.set(match.index, Boolean(stack.at(-1)?.hidden));
        }
    }
    return states;
}

function htmlAnchorRecords(content, labels = htmlIdLabels(content)) {
    const anchors = [];
    const closing = /<\/a\s*>/gi;
    const hiddenStates = htmlAnchorHiddenStates(content);
    const openings = [];
    for (const match of content.matchAll(/<a\b/gi)) {
        const openingEnd = htmlOpeningTagEnd(content, match.index);
        if (openingEnd === -1) break;
        openings.push({ index: match.index, openingEnd });
    }
    for (const [index, match] of openings.entries()) {
        const { openingEnd } = match;
        const openingTag = content.slice(match.index, openingEnd);
        closing.lastIndex = openingEnd;
        const close = closing.exec(content);
        const nextOpening = openings[index + 1]?.index ?? -1;
        const autoClosed = nextOpening !== -1 && (!close || nextOpening < close.index);
        const contentEnd = autoClosed ? nextOpening : (close?.index ?? content.length);
        const anchorEnd = autoClosed
            ? nextOpening
            : (close ? close.index + close[0].length : content.length);
        const nestedName = contentEnd > openingEnd
            ? accessibleHtmlText(content.slice(openingEnd, contentEnd), labels)
                .replace(/\s+/g, ' ').trim()
            : '';
        const visualName = contentEnd > openingEnd
            ? visuallyRenderedHtmlText(content.slice(openingEnd, contentEnd))
                .replace(/\s+/g, ' ').trim()
            : '';
        const following = content.slice(anchorEnd, Math.min(content.length, anchorEnd + 2_000));
        const nextAnchorOffset = following.search(/<a\b/i);
        const adjacentContextAfterEnd = nextAnchorOffset === -1
            ? anchorEnd + following.length
            : anchorEnd + nextAnchorOffset;
        const previousAnchor = anchors.at(-1);
        const previousAnchorEnd = previousAnchor?.end <= match.index
            ? previousAnchor.end
            : 0;
        const rawBefore = content.slice(
            Math.max(previousAnchorEnd, match.index - 2_000),
            match.index
        );
        const rawAfter = content.slice(anchorEnd, adjacentContextAfterEnd);
        const beforeBoundary = htmlContextBeforeBoundary(rawBefore);
        const afterBoundary = htmlContextAfterBoundary(rawAfter);
        const repairedPriorLabel = previousAnchor?.autoClosed
            && previousAnchor.end === match.index
            ? previousAnchor.label
            : '';
        const contextBefore = `${repairedPriorLabel} ${
            compactVisibleText(rawBefore.slice(beforeBoundary), labels)
        }`.replace(/\s+/g, ' ').trim();
        const accessibleName = ariaLabelledText(openingTag, labels)
            || htmlAttributeValue(openingTag, 'aria-label')
            || nestedName
            || htmlAttributeValue(openingTag, 'title');
        anchors.push({
            start: match.index,
            openingEnd,
            end: anchorEnd,
            closed: Boolean(close) || autoClosed,
            autoClosed,
            label: combinedHtmlLabel(accessibleName, visualName),
            hidden: hiddenStates.get(match.index) || false,
            contextBefore,
            contextBeforePrior: previousAnchor && beforeBoundary === 0
                ? `${previousAnchor.contextBeforePrior || ''} ${previousAnchor.contextBefore || ''}`
                    .replace(/\s+/g, ' ').trim()
                : '',
            contextBeforeBlock: htmlPriorBlockText(rawBefore, beforeBoundary, labels),
            contextAfter: compactVisibleText(
                rawAfter.slice(0, afterBoundary),
                labels
            ),
            contextBeforeStartsAtLink: Boolean(previousAnchor)
                && previousAnchorEnd > 0
                && beforeBoundary === 0,
            contextAfterEndsAtLink: nextAnchorOffset !== -1 && afterBoundary === rawAfter.length,
        });
    }
    return anchors;
}

function htmlLinks(content, line, labels = htmlIdLabels(content)) {
    const links = [];
    const visible = stripHtmlComments(content);
    const context = compactVisibleText(visible);
    const anchors = htmlAnchorRecords(visible, labels);
    let anchorIndex = 0;
    for (const attribute of htmlAttributeRecords(content)) {
        if (attribute.name === 'href') {
            while (anchorIndex < anchors.length
                && attribute.index >= anchors[anchorIndex].openingEnd) {
                anchorIndex += 1;
            }
            const candidate = anchors[anchorIndex];
            const anchor = candidate
                && attribute.index >= candidate.start
                && attribute.index < candidate.openingEnd
                ? candidate
                : null;
            links.push({
                target: normalizeLinkTarget(attribute.value),
                line,
                type: 'link',
                label: anchor?.label || '',
                context,
                contextBefore: anchor?.contextBefore || '',
                contextBeforePrior: anchor?.contextBeforePrior || '',
                contextBeforeBlock: anchor?.contextBeforeBlock || '',
                contextAfter: anchor?.contextAfter || '',
                contextBeforeStartsAtLink: anchor?.contextBeforeStartsAtLink || false,
                contextAfterEndsAtLink: anchor?.contextAfterEndsAtLink || false,
                hidden: anchor?.hidden || false,
            });
        } else if (attribute.name === 'src') {
            links.push({
                target: normalizeLinkTarget(attribute.value),
                line,
                type: 'image',
                label: '',
            });
        } else if (attribute.name === 'srcset') {
            for (const candidate of attribute.value.split(',')) {
                const target = candidate.trim().split(/\s+/)[0];
                if (target) {
                    links.push({
                        target: normalizeLinkTarget(target),
                        line,
                        type: 'image',
                        label: '',
                    });
                }
            }
        }
    }
    return links;
}

function inlineHtmlAnchorRecord(children, start, labels) {
    const opening = children[start]?.content || '';
    const anchor = htmlAnchorRecords(opening, labels)[0];
    if (!anchor) return null;
    if (anchor.closed) {
        return anchor.label ? { label: anchor.label, endIndex: start } : null;
    }
    const openingTag = opening.slice(anchor.start, anchor.openingEnd);
    const explicitName = ariaLabelledText(openingTag, labels)
        || htmlAttributeValue(openingTag, 'aria-label');
    const title = htmlAttributeValue(openingTag, 'title');
    let body = opening.slice(anchor.openingEnd);
    const record = (endIndex, autoClosed = false) => {
        const label = combinedHtmlLabel(explicitName, governedHtmlText(body, labels)) || title;
        return label ? { label, endIndex, autoClosed } : null;
    };
    for (let index = start + 1; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'html_inline') {
            const nestedOpening = child.content.search(/<a\b/i);
            const closing = child.content.search(/<\/a\s*>/i);
            if (nestedOpening !== -1 && (closing === -1 || nestedOpening < closing)) {
                body += child.content.slice(0, nestedOpening);
                return record(index - 1, true);
            }
            body += closing === -1 ? child.content : child.content.slice(0, closing);
            if (closing !== -1) {
                return record(index);
            }
        } else if (child.type === 'text' || child.type === 'code_inline') {
            body += markdown.utils.escapeHtml(child.content);
        } else if (child.type === 'image') {
            body += markdown.utils.escapeHtml(child.content);
        } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
            body += ' ';
        }
    }
    return record(children.length - 1);
}

function normalizeLinkTarget(target) {
    const decoded = markdown.utils.unescapeAll(String(target || '').trim());
    if (/^www\./i.test(decoded)) return `http://${decoded}`;
    if (decoded.startsWith('//')) return `https:${decoded}`;
    return decoded;
}

function inlineLabel(children, start) {
    const label = [];
    let depth = 1;
    for (let index = start + 1; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'link_open') depth += 1;
        if (child.type === 'link_close') {
            depth -= 1;
            if (depth === 0) break;
        }
        label.push(child);
    }
    return governedInlineText(label);
}

function inlineLinkEnd(children, start) {
    let depth = 1;
    for (let index = start + 1; index < children.length; index += 1) {
        if (children[index].type === 'link_open') depth += 1;
        if (children[index].type === 'link_close') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return start;
}

function inlineSemanticText(children = []) {
    return governedInlineText(children);
}

function inlineLinkRegions(children, labels) {
    const regions = [];
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'link_open') {
            regions.push({
                startIndex: index,
                endIndex: inlineLinkEnd(children, index),
            });
            continue;
        }
        if (child.type !== 'html_inline') continue;
        const html = htmlLinks(child.content, 1, labels);
        if (!html.some(link => link.type === 'link')) continue;
        const record = inlineHtmlAnchorRecord(children, index, labels);
        regions.push({
            startIndex: index,
            endIndex: record?.endIndex ?? index,
            html,
            record,
        });
    }
    const contextual = [];
    for (const [index, region] of regions.entries()) {
        const previous = contextual.at(-1);
        const next = regions[index + 1];
        const contextBefore = inlineSemanticText(children.slice(
            previous ? previous.endIndex + 1 : 0,
            region.startIndex
        ));
        const repairedPriorLabel = previous?.record?.autoClosed
            && previous.endIndex + 1 === region.startIndex
            ? previous.record.label
            : '';
        contextual.push({
            ...region,
            contextBefore: `${repairedPriorLabel} ${contextBefore}`
                .replace(/\s+/g, ' ').trim(),
            contextBeforePrior: previous
                ? `${previous.contextBeforePrior || ''} ${previous.contextBefore || ''}`
                    .replace(/\s+/g, ' ').trim()
                : '',
            contextAfter: inlineSemanticText(children.slice(
                region.endIndex + 1,
                next ? next.startIndex : children.length
            )),
            contextBeforeStartsAtLink: Boolean(previous),
            contextAfterEndsAtLink: Boolean(next),
        });
    }
    return contextual;
}

function wwwAutolinks(content, line, context = '', contextBefore = '', contextAfter = '') {
    return (gfmWwwLinkifier.match(content) || [])
        .filter(match => /^www\./i.test(match.raw))
        .map(match => ({
            target: normalizeLinkTarget(match.raw),
            line,
            type: 'link',
            label: match.raw,
            context,
            contextBefore: `${contextBefore} ${content.slice(0, match.index)}`
                .replace(/\s+/g, ' ').trim(),
            contextAfter: `${content.slice(match.lastIndex)} ${contextAfter}`
                .replace(/\s+/g, ' ').trim(),
        }));
}

function extractLinksFromTokens(tokens) {
    const links = [];
    let previousBlockText = '';
    const htmlLabels = htmlIdLabels(tokens.flatMap((token) => {
        if (token.type === 'html_block') return [token.content];
        if (token.type === 'inline') return [token.content];
        return [];
    }).join('\n'));
    for (const token of tokens) {
        const line = (token.map?.[0] || 0) + 1;
        if (token.type === 'html_block') {
            const html = htmlLinks(token.content, line, htmlLabels);
            for (const link of html) {
                if (!link.contextBeforeBlock) link.contextBeforeBlock = previousBlockText;
            }
            links.push(...html);
            const blockText = compactVisibleText(token.content, htmlLabels);
            if (blockText) previousBlockText = blockText;
        }
        if (token.type !== 'inline') continue;
        let childLine = line;
        let linkDepth = 0;
        const htmlVisibilityStack = [];
        const children = token.children || [];
        const context = inlineSemanticText(children);
        const regions = inlineLinkRegions(children, htmlLabels);
        const regionsByStart = new Map(regions.map(region => [region.startIndex, region]));
        for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            if (child.type === 'link_open') {
                const region = regionsByStart.get(index);
                links.push({
                    target: normalizeLinkTarget(child.attrGet('href')),
                    line: childLine,
                    type: 'link',
                    label: inlineLabel(children, index),
                    context,
                    contextBefore: region.contextBefore,
                    contextBeforePrior: region.contextBeforePrior,
                    contextBeforeBlock: previousBlockText,
                    contextAfter: region.contextAfter,
                    contextBeforeStartsAtLink: region.contextBeforeStartsAtLink,
                    contextAfterEndsAtLink: region.contextAfterEndsAtLink,
                    hidden: Boolean(htmlVisibilityStack.at(-1)?.hidden),
                });
                linkDepth += 1;
            } else if (child.type === 'link_close') {
                linkDepth = Math.max(0, linkDepth - 1);
            } else if (child.type === 'image') {
                links.push({
                    target: normalizeLinkTarget(child.attrGet('src')),
                    line: childLine,
                    type: 'image',
                    label: child.content.trim(),
                    hidden: Boolean(htmlVisibilityStack.at(-1)?.hidden),
                });
            } else if (child.type === 'text'
                && linkDepth === 0
                && /\bwww\./i.test(child.content)) {
                links.push(...wwwAutolinks(
                    child.content,
                    childLine,
                    context,
                    inlineSemanticText(children.slice(0, index)),
                    inlineSemanticText(children.slice(index + 1))
                ));
            } else if (child.type === 'html_inline') {
                const region = regionsByStart.get(index);
                const html = region?.html || htmlLinks(child.content, childLine, htmlLabels);
                const record = region?.record || inlineHtmlAnchorRecord(
                    children,
                    index,
                    htmlLabels
                );
                const anchor = html.find(link => link.type === 'link');
                if (anchor && record?.label) anchor.label = record.label;
                const htmlRouteLinks = html.filter(link => link.type === 'link');
                const firstRouteIndex = html.indexOf(htmlRouteLinks[0]);
                const lastRouteIndex = html.indexOf(htmlRouteLinks.at(-1));
                for (const [linkIndex, link] of html.entries()) {
                    link.line = childLine;
                    link.hidden ||= Boolean(htmlVisibilityStack.at(-1)?.hidden);
                    link.context = context;
                    if (region && linkIndex === firstRouteIndex) {
                        link.contextBefore = `${region.contextBefore} `
                            + `${link.contextBefore || ''}`;
                        link.contextBeforePrior = `${region.contextBeforePrior} `
                            + `${link.contextBeforePrior || ''}`;
                        link.contextBeforeStartsAtLink ||= region.contextBeforeStartsAtLink;
                    }
                    link.contextBeforeBlock ||= previousBlockText;
                    if (region && linkIndex === lastRouteIndex) {
                        link.contextAfter = `${link.contextAfter || ''} `
                            + `${region.contextAfter}`;
                        link.contextAfterEndsAtLink ||= region.contextAfterEndsAtLink;
                    }
                    link.contextBefore = String(link.contextBefore || '')
                        .replace(/\s+/g, ' ').trim();
                    link.contextBeforePrior = String(link.contextBeforePrior || '')
                        .replace(/\s+/g, ' ').trim();
                    link.contextAfter = String(link.contextAfter || '')
                        .replace(/\s+/g, ' ').trim();
                }
                links.push(...html);
                updateHtmlVisibilityStack(htmlVisibilityStack, child.content);
            }
            if (child.type === 'softbreak' || child.type === 'hardbreak') childLine += 1;
        }
        if (context) previousBlockText = context;
    }
    return links;
}

function maskNonRenderedHtml(content) {
    const mask = value => value.replace(/[^\r\n]/g, ' ');
    return content
        .replace(/<!--[\s\S]*?(?:-->|$)/g, mask)
        .replace(
            /<(pre|code|script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi,
            mask
        );
}

function markdownInHtmlLinks(tokens) {
    const links = [];
    for (const token of tokens) {
        if (token.type !== 'html_block') continue;
        const source = maskNonRenderedHtml(token.content);
        const opening = /<([a-z][a-z0-9:-]*)\b/gi;
        let match;
        while ((match = opening.exec(source)) !== null) {
            const openingEnd = htmlOpeningTagEnd(source, match.index);
            if (openingEnd === -1) break;
            const openingTag = source.slice(match.index, openingEnd);
            const markdownMode = htmlAttributeValue(openingTag, 'markdown').toLowerCase();
            const bareMarkdown = /\smarkdown(?=\s|\/?>)/i.test(openingTag);
            if (!['1', 'block', 'span', 'markdown'].includes(markdownMode) && !bareMarkdown) {
                opening.lastIndex = openingEnd;
                continue;
            }
            const closing = new RegExp(`</${match[1]}\\s*>`, 'ig');
            closing.lastIndex = openingEnd;
            const close = closing.exec(source);
            if (!close) {
                opening.lastIndex = openingEnd;
                continue;
            }
            const body = source.slice(openingEnd, close.index);
            const lineOffset = (token.map?.[0] || 0)
                + source.slice(0, openingEnd).split('\n').length - 1;
            const containerHidden = htmlElementIsHidden(source, match.index, openingTag);
            for (const link of extractLinks(body)) {
                links.push({
                    ...link,
                    line: link.line + lineOffset,
                    hidden: containerHidden || link.hidden,
                });
            }
            opening.lastIndex = close.index + close[0].length;
        }
    }
    return links;
}

function extractLinks(source) {
    const tokens = markdown.parse(source, {});
    const links = [
        ...extractLinksFromTokens(tokens),
        ...markdownInHtmlLinks(tokens),
    ];
    const seen = new Set();
    return links.filter((link) => {
        const key = [
            link.target,
            link.line,
            link.type,
            link.label,
            link.contextBefore,
            link.contextBeforeBlock,
            link.contextAfter,
            link.hidden,
        ].join('\u0000');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function extractRenderedHtmlLinks(source) {
    return htmlLinks(source, 1);
}

function isActionableLink(link) {
    return link?.type === 'link' && !link.hidden && Boolean(link.label?.trim());
}

function splitTarget(rawTarget) {
    const hashAt = rawTarget.indexOf('#');
    const pathAndQuery = hashAt === -1 ? rawTarget : rawTarget.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : rawTarget.slice(hashAt + 1);
    const queryAt = pathAndQuery.indexOf('?');
    return {
        pathname: queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt),
        fragment,
    };
}

function isExternal(target) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

function collectMarkdownFiles(root = ROOT) {
    const files = [...REQUIRED_FILES];
    const docsRoot = path.join(root, 'docs');
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
                files.push(path.relative(root, absolute));
            }
        }
    };
    if (fs.existsSync(docsRoot)) visit(docsRoot);
    return files;
}

function validateMarkdownFile(file, root = ROOT) {
    const absoluteFile = path.resolve(root, file);
    const relativeFile = path.relative(root, absoluteFile);
    const problems = [];
    if (relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
        return [`${file}: outside repository root`];
    }
    if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
        return [`${file}: file does not exist`];
    }

    const source = fs.readFileSync(absoluteFile, 'utf8');
    for (const link of extractLinks(source)) {
        if (link.hidden) continue;
        if (!link.target || isExternal(link.target)) continue;
        let decoded;
        try {
            decoded = decodeURIComponent(link.target);
        } catch {
            problems.push(`${relativeFile}:${link.line}: invalid percent-encoding in ${link.target}`);
            continue;
        }

        const target = splitTarget(decoded);
        const targetFile = target.pathname
            ? path.resolve(path.dirname(absoluteFile), target.pathname)
            : absoluteFile;
        const relativeTarget = path.relative(root, targetFile);
        if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
            problems.push(`${relativeFile}:${link.line}: link escapes repository: ${link.target}`);
            continue;
        }
        if (!fs.existsSync(targetFile)) {
            problems.push(`${relativeFile}:${link.line}: target does not exist: ${link.target}`);
            continue;
        }
        if (!target.fragment || fs.statSync(targetFile).isDirectory()) continue;
        if (path.extname(targetFile).toLowerCase() !== '.md') {
            problems.push(`${relativeFile}:${link.line}: cannot validate fragment on non-Markdown target: ${link.target}`);
            continue;
        }
        const dialect = relativeTarget.split(path.sep)[0] === 'docs' ? 'mkdocs' : 'github';
        const anchors = markdownAnchors(fs.readFileSync(targetFile, 'utf8'), dialect);
        if (!anchors.has(target.fragment)) {
            problems.push(`${relativeFile}:${link.line}: heading does not exist: ${link.target}`);
        }
    }
    return problems;
}

function checkMarkdownLinks(files, root = ROOT) {
    const selected = files || collectMarkdownFiles(root);
    return selected.flatMap(file => validateMarkdownFile(file, root));
}

function main() {
    const files = process.argv.slice(2);
    const selected = files.length > 0 ? files : collectMarkdownFiles();
    const problems = checkMarkdownLinks(selected);
    if (problems.length > 0) {
        console.error(`Internal Markdown link check failed:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    console.log(`Internal Markdown links OK: ${selected.length} files`);
}

if (require.main === module) main();

module.exports = {
    checkMarkdownLinks,
    collectMarkdownFiles,
    extractLinks,
    extractLinksFromTokens,
    extractRenderedHtmlLinks,
    governedHtmlText,
    headingSlug,
    htmlAttributes,
    htmlTagIsHidden,
    isActionableLink,
    markdownAnchors,
    markdownHeadingAnchors,
    mkdocsHeadingSlug,
    normalizeLinkTarget,
    stripHtmlComments,
    updateHtmlVisibilityStack,
    validateMarkdownFile,
    visibleHtmlText,
};
