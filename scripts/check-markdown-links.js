'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

const ROOT = path.join(__dirname, '..');
const REQUIRED_FILES = ['README.md', 'CONTRIBUTING.md'];
const MAX_HTML_LABEL_LENGTH = 8_192;
const HTML_LABEL_OVERFLOW_MARKER =
    '[label truncated: support feature bug vulnerability security question help issue report request]';
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

function stripHiddenHtml(content, excludeAriaHidden = false, initialState = null) {
    const source = stripHtmlComments(content);
    const visible = [];
    const stack = initialState
        ? [{
            tag: null,
            persistentHidden: Boolean(initialState.persistentHidden),
            visibilityHidden: Boolean(initialState.visibilityHidden),
            hidden: Boolean(initialState.persistentHidden || initialState.visibilityHidden),
        }]
        : [];
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
        const hiddenBefore = Boolean(stack.at(-1)?.hidden);
        if (!hiddenBefore) visible.push(source.slice(offset, match.index));
        const closing = match[1] === '/';
        const openingState = closing
            ? null
            : htmlOpeningVisibilityState(stack, match[0], excludeAriaHidden);
        updateHtmlVisibilityStack(stack, match[0], excludeAriaHidden);
        const hiddenAfter = Boolean(stack.at(-1)?.hidden);
        if (closing
            ? !hiddenBefore && !hiddenAfter
            : !openingState.hidden) {
            visible.push(match[0]);
        }
        offset = match.index + match[0].length;
    }
    if (!stack.at(-1)?.hidden) visible.push(source.slice(offset));
    return visible.join('');
}

function accessibleHtmlText(
    content,
    labels = new Map(),
    excludeAriaHidden = true,
    initialState = null
) {
    const visible = stripHiddenHtml(content, excludeAriaHidden, initialState)
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(
            /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/svg\s*>/gi,
            (element, attributes, body) => {
                const openingTag = `<svg${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeText(openingTag, 'aria-label')
                    || htmlAttributeText(openingTag, 'title')
                    || accessibleHtmlText(body, labels, excludeAriaHidden);
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(/<svg\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/gi, (tag) => {
            const name = ariaLabelledText(tag, labels)
                || htmlAttributeText(tag, 'aria-label')
                || htmlAttributeText(tag, 'title');
            return name ? ` ${name} ` : ' ';
        })
        .replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
            const name = ariaLabelledText(tag, labels)
                || htmlAttributeText(tag, 'aria-label')
                || htmlAttributeText(tag, 'alt')
                || htmlAttributeText(tag, 'title');
            return name ? ` ${name} ` : ' ';
        })
        .replace(
            /<(button|summary|textarea|select|output|iframe)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi,
            (element, tag, attributes, body) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = htmlElementAccessibleName(
                    tag.toLowerCase(),
                    openingTag,
                    accessibleHtmlText(body, labels, excludeAriaHidden),
                    labels
                );
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (openingTag) => {
            const name = htmlElementAccessibleName('input', openingTag, '', labels);
            return name ? ` ${name} ` : ' ';
        })
        .replace(
            /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*\stitle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi,
            (element, tag, attributes, body) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = htmlElementAccessibleName(
                    tag.toLowerCase(),
                    openingTag,
                    accessibleHtmlText(body, labels, excludeAriaHidden),
                    labels
                );
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(
            /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*\saria-(?:label|labelledby)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi,
            (element, tag, attributes, body) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeText(openingTag, 'aria-label')
                    || htmlAttributeText(openingTag, 'title')
                    || accessibleHtmlText(body, labels, excludeAriaHidden);
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(
            /<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*\saria-(?:label|labelledby)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)(?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi,
            (element, tag, attributes) => {
                const openingTag = `<${tag}${attributes}>`;
                const name = ariaLabelledText(openingTag, labels)
                    || htmlAttributeText(openingTag, 'aria-label')
                    || htmlAttributeText(openingTag, 'title');
                return name ? ` ${name} ` : ' ';
            }
        )
        .replace(/<[^>]*>/g, ' ');
    return markdown.utils.unescapeAll(visible);
}

function visibleHtmlText(content, labels = new Map()) {
    return accessibleHtmlText(content, labels, false);
}

function visuallyRenderedHtmlText(content, initialState = null) {
    const visible = stripHiddenHtml(content, false, initialState)
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
    if (!accessibleLabel) return boundedDomText([visualLabel]);
    if (!visualLabel || accessibleLabel.toLowerCase() === visualLabel.toLowerCase()) {
        return boundedDomText([accessibleLabel]);
    }
    return boundedDomText([accessibleLabel, visualLabel]);
}

function governedHtmlText(content, labels = new Map(), initialStates = {}) {
    return combinedHtmlLabel(
        accessibleHtmlText(content, labels, true, initialStates.accessibility),
        visuallyRenderedHtmlText(content, initialStates.visual)
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

function compactGovernedText(content, labels = new Map(), initialStates = {}) {
    return governedHtmlText(content, labels, initialStates).replace(/\s+/g, ' ').trim();
}

function boundedDomText(parts) {
    let text = '';
    let overflow = false;
    for (const part of parts) {
        const compact = String(part || '').replace(/\s+/g, ' ').trim();
        if (!compact) continue;
        if (compact.includes(HTML_LABEL_OVERFLOW_MARKER)) overflow = true;
        const separator = text ? 1 : 0;
        const remaining = MAX_HTML_LABEL_LENGTH - text.length - separator;
        if (remaining <= 0) {
            overflow = true;
            break;
        }
        if (separator) text += ' ';
        if (compact.length > remaining) {
            text += compact.slice(0, remaining);
            overflow = true;
            break;
        }
        text += compact;
    }
    if (!overflow) return text;
    const contentLimit = MAX_HTML_LABEL_LENGTH - HTML_LABEL_OVERFLOW_MARKER.length - 1;
    const content = text
        .replaceAll(HTML_LABEL_OVERFLOW_MARKER, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, contentLimit)
        .trimEnd();
    return `${content}${content ? ' ' : ''}${HTML_LABEL_OVERFLOW_MARKER}`;
}

function htmlLabelIsTruncated(label) {
    return String(label || '').includes(HTML_LABEL_OVERFLOW_MARKER);
}

function htmlAttributeText(tag, name) {
    return boundedDomText([htmlAttributeValue(tag, name)]);
}

function htmlLabelGraphComponents(dependencies) {
    const reverse = dependencies.map(() => []);
    for (const [node, edges] of dependencies.entries()) {
        for (const edge of edges) reverse[edge.node].push(node);
    }

    const visited = new Uint8Array(dependencies.length);
    const order = [];
    for (let start = 0; start < dependencies.length; start += 1) {
        if (visited[start]) continue;
        visited[start] = 1;
        const stack = [{ node: start, edge: 0 }];
        while (stack.length > 0) {
            const frame = stack.at(-1);
            const edges = dependencies[frame.node];
            if (frame.edge < edges.length) {
                const dependency = edges[frame.edge].node;
                frame.edge += 1;
                if (!visited[dependency]) {
                    visited[dependency] = 1;
                    stack.push({ node: dependency, edge: 0 });
                }
                continue;
            }
            order.push(frame.node);
            stack.pop();
        }
    }

    const components = new Int32Array(dependencies.length);
    components.fill(-1);
    let component = 0;
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const start = order[index];
        if (components[start] !== -1) continue;
        components[start] = component;
        const stack = [start];
        while (stack.length > 0) {
            const node = stack.pop();
            for (const dependent of reverse[node]) {
                if (components[dependent] !== -1) continue;
                components[dependent] = component;
                stack.push(dependent);
            }
        }
        component += 1;
    }
    return components;
}

const HTML_INPUT_TYPES = new Set([
    'button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file',
    'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset',
    'search', 'submit', 'tel', 'text', 'time', 'url', 'week',
]);

function htmlNativeAccessibleName(record, body) {
    const attribute = name => htmlAttributeText(record.openingTag, name);
    const title = attribute('title');
    if (record.tag === 'button' || record.tag === 'summary' || record.tag === 'a') {
        return body || title;
    }
    if (record.tag === 'input') {
        const declaredType = attribute('type').toLowerCase() || 'text';
        const type = HTML_INPUT_TYPES.has(declaredType) ? declaredType : 'text';
        if (type === 'image') return attribute('alt') || title;
        if (['button', 'submit', 'reset'].includes(type)) {
            return attribute('value') || title;
        }
        if (['text', 'password', 'number', 'search', 'tel', 'email', 'url'].includes(type)) {
            return attribute('value')
                || title
                || attribute('placeholder')
                || attribute('aria-placeholder');
        }
        if (type === 'range') return attribute('value') || title;
        return title;
    }
    if (record.tag === 'textarea') {
        return body || title || attribute('placeholder') || attribute('aria-placeholder');
    }
    if (record.tag === 'select' || record.tag === 'output') return body || title;
    if (record.tag === 'meter' || record.tag === 'progress') {
        return attribute('value') || body || title;
    }
    return title;
}

function htmlElementAccessibleName(tag, openingTag, body, labels) {
    const id = htmlAttributeText(openingTag, 'id');
    return (id && labels.get(id))
        || ariaLabelledText(openingTag, labels)
        || htmlAttributeText(openingTag, 'aria-label')
        || htmlNativeAccessibleName({ tag, openingTag }, boundedDomText([body]))
        || boundedDomText([body]);
}

const HTML_LABELABLE_ELEMENTS = new Set([
    'button', 'input', 'meter', 'output', 'progress', 'select', 'textarea',
]);

function htmlAssociatedLabelParts(records, label, control) {
    const parts = [];
    const controlAncestors = new Set();
    for (let index = control.parentIndex; index !== -1; ) {
        controlAncestors.add(index);
        index = records[index]?.parentIndex ?? -1;
    }
    const visit = (candidate) => {
        for (const part of candidate.parts) {
            if (typeof part === 'string') {
                parts.push(part);
            } else if (part.index === control.index) {
                continue;
            } else if (controlAncestors.has(part.index)) {
                visit(part);
            } else {
                parts.push(part);
            }
        }
    };
    visit(label);
    return parts;
}

function htmlAssociatedLabelNodes(records, ids) {
    const associations = [];
    const wrappedControls = new Map();
    for (const candidate of records) {
        if (candidate.labelAncestorIndex === -1
            || !HTML_LABELABLE_ELEMENTS.has(candidate.tag)
            || candidate.tag === 'input'
                && htmlAttributeText(candidate.openingTag, 'type').toLowerCase() === 'hidden'
            || wrappedControls.has(candidate.labelAncestorIndex)) {
            continue;
        }
        wrappedControls.set(candidate.labelAncestorIndex, candidate);
    }
    for (const label of records.filter(record => record.tag === 'label')) {
        const hasExplicitFor = /\sfor(?:\s*=|\s|\/?>)/i.test(label.openingTag);
        const explicitId = htmlAttributeText(label.openingTag, 'for');
        const control = hasExplicitFor ? ids.get(explicitId) : wrappedControls.get(label.index);
        if (!control || !HTML_LABELABLE_ELEMENTS.has(control.tag)) continue;
        if (control.tag === 'input'
            && htmlAttributeText(control.openingTag, 'type').toLowerCase() === 'hidden') {
            continue;
        }
        associations.push({
            control,
            label,
            parts: htmlAssociatedLabelParts(records, label, control),
        });
    }
    return associations;
}

function resolvedHtmlIdLabels(records, ids) {
    const idEntries = [...ids];
    const associationNodes = htmlAssociatedLabelNodes(records, ids);
    const associationOffset = records.length;
    const idOffset = associationOffset + associationNodes.length;
    const labelNodeById = new Map(idEntries.map(
        ([id], index) => [id, idOffset + index]
    ));
    const dependencies = Array.from(
        { length: idOffset + idEntries.length },
        () => []
    );

    for (const record of records) record.associatedLabelNodes = [];
    for (const [index, association] of associationNodes.entries()) {
        const node = associationOffset + index;
        association.control.associatedLabelNodes.push(node);
        dependencies[association.control.index].push({ node, reference: true });
        for (const part of association.parts) {
            if (typeof part !== 'string') {
                dependencies[node].push({ node: part.index, reference: false });
            }
        }
    }

    for (const record of records) {
        const labelledBy = htmlAttributeValue(record.openingTag, 'aria-labelledby');
        record.referenceIds = [...new Set(
            labelledBy
                .split(/\s+/)
                .filter(id => labelNodeById.has(id))
        )];
        record.usesResolvedAccessibleName = ['img', 'svg'].includes(record.tag)
            || Boolean(labelledBy)
            || record.associatedLabelNodes.length > 0;
        for (const part of record.parts) {
            if (typeof part !== 'string') {
                dependencies[record.index].push({ node: part.index, reference: false });
            }
        }
        for (const id of record.referenceIds) {
            dependencies[record.index].push({
                node: labelNodeById.get(id),
                reference: true,
            });
        }
    }

    for (const [entryIndex, [, record]] of idEntries.entries()) {
        const directLabel = htmlAttributeText(record.openingTag, 'aria-label')
            || htmlAttributeText(record.openingTag, 'title');
        const readsRecordValue = !record.visualState.persistentHidden
            && !record.accessibilityState.persistentHidden
            && (record.accessibilityState.hidden
                || record.usesResolvedAccessibleName
                || !directLabel);
        if (readsRecordValue) {
            dependencies[idOffset + entryIndex].push({
                node: record.index,
                reference: false,
            });
        }
    }

    const components = htmlLabelGraphComponents(dependencies);
    const filtered = dependencies.map((edges, node) => edges.filter(edge => (
        !edge.reference || components[node] !== components[edge.node]
    )));
    const dependents = filtered.map(() => []);
    const pending = new Uint32Array(filtered.length);
    for (const [node, edges] of filtered.entries()) {
        pending[node] = edges.length;
        for (const edge of edges) dependents[edge.node].push(node);
    }

    const values = Array(filtered.length).fill('');
    const queue = [];
    for (let node = 0; node < filtered.length; node += 1) {
        if (pending[node] === 0) queue.push(node);
    }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const node = queue[cursor];
        if (node < records.length) {
            const record = records[node];
            if (!['script', 'style'].includes(record.tag)) {
                const body = boundedDomText(record.parts.map(part => (
                    typeof part === 'string'
                        ? record.accessibilityState.hidden ? '' : part
                        : values[part.index]
                )));
                let text = body;
                if (!record.accessibilityState.hidden) {
                    const referenced = boundedDomText(record.referenceIds
                        .filter(id => (
                            components[node] !== components[labelNodeById.get(id)]
                        ))
                        .map(id => values[labelNodeById.get(id)]));
                    const ariaLabel = htmlAttributeText(record.openingTag, 'aria-label');
                    const associated = boundedDomText(
                        record.associatedLabelNodes.map(index => values[index])
                    );
                    const title = htmlAttributeText(record.openingTag, 'title');
                    if (record.tag === 'img') {
                        text = referenced
                            || ariaLabel
                            || associated
                            || htmlAttributeText(record.openingTag, 'alt')
                            || title;
                    } else if (record.tag === 'svg'
                        || ariaLabel
                        || htmlAttributeValue(record.openingTag, 'aria-labelledby')) {
                        text = referenced
                            || ariaLabel
                            || associated
                            || htmlNativeAccessibleName(record, body)
                            || title
                            || body;
                    } else {
                        text = associated || htmlNativeAccessibleName(record, body) || body;
                    }
                }
                values[node] = boundedDomText([text]);
            }
        } else if (node < idOffset) {
            const association = associationNodes[node - associationOffset];
            const body = boundedDomText(association.parts.map(part => (
                typeof part === 'string' ? part : values[part.index]
            )));
            values[node] = boundedDomText([
                htmlAttributeText(association.label.openingTag, 'aria-label')
                    || body
                    || htmlAttributeText(association.label.openingTag, 'title'),
            ]);
        } else {
            const [, record] = idEntries[node - idOffset];
            let label = record.accessibilityState.hidden
                ? ''
                : record.usesResolvedAccessibleName
                    ? values[record.index]
                    : htmlAttributeText(record.openingTag, 'aria-label')
                        || htmlAttributeText(record.openingTag, 'title')
                        || '';
            if (!record.visualState.persistentHidden && !label) {
                label = record.accessibilityState.persistentHidden
                    ? record.visualText
                    : combinedHtmlLabel(values[record.index], record.visualText);
            }
            values[node] = boundedDomText([label]);
        }
        for (const dependent of dependents[node]) {
            pending[dependent] -= 1;
            if (pending[dependent] === 0) queue.push(dependent);
        }
    }

    return new Map(idEntries.flatMap(([id], index) => {
        const label = values[idOffset + index];
        return label ? [[id, label]] : [];
    }));
}

function htmlIdLabels(content) {
    const source = stripHtmlComments(content);
    if (!htmlAttributeRecords(source).some(attribute => attribute.name === 'id')) {
        return new Map();
    }
    const records = [];
    const ids = new Map();
    const stack = [];
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
        const currentRawTextTag = ['script', 'style'].includes(stack.at(-1)?.tag)
            ? stack.at(-1).tag
            : '';
        const closing = match[1] === '/';
        const tag = match[2].toLowerCase();
        if (currentRawTextTag && !(closing && tag === currentRawTextTag)) {
            continue;
        }
        if (stack.length > 0 && match.index > offset) {
            stack.at(-1).parts.push(markdown.utils.unescapeAll(
                source.slice(offset, match.index)
            ));
        }
        if (closing) {
            const opening = lastHtmlStackTagIndex(stack, tag);
            if (opening !== -1) stack.splice(opening);
            offset = match.index + match[0].length;
            continue;
        }
        if (tag === 'a') {
            const activeAnchor = lastHtmlStackTagIndex(stack, tag);
            if (activeAnchor !== -1) stack.splice(activeAnchor);
        }
        const parent = stack.at(-1) || null;
        const openingTag = match[0];
        const visualState = htmlOpeningVisibilityState(
            parent ? [parent.visualState] : [],
            openingTag
        );
        const accessibilityState = htmlOpeningVisibilityState(
            parent ? [parent.accessibilityState] : [],
            openingTag,
            true
        );
        const record = {
            index: records.length,
            tag,
            openingTag,
            parentIndex: parent?.index ?? -1,
            labelAncestorIndex: parent?.tag === 'label'
                ? parent.index
                : parent?.labelAncestorIndex ?? -1,
            visualState,
            accessibilityState,
            parts: [],
        };
        if (parent) parent.parts.push(record);
        records.push(record);
        const id = htmlAttributeValue(openingTag, 'id');
        if (id && !ids.has(id)) ids.set(id, record);
        const selfClosing = /\/>\s*$/.test(openingTag) || HTML_VOID_ELEMENTS.has(tag);
        if (!selfClosing) stack.push(record);
        offset = match.index + match[0].length;
    }
    if (stack.length > 0 && offset < source.length) {
        stack.at(-1).parts.push(markdown.utils.unescapeAll(source.slice(offset)));
    }

    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (['script', 'style', 'desc', 'title'].includes(record.tag)) {
            record.visualText = '';
            continue;
        }
        record.visualText = boundedDomText(record.parts.map(part => (
            typeof part === 'string'
                ? record.visualState.hidden ? '' : part
                : part.visualText
        )));
    }
    return resolvedHtmlIdLabels(records, ids);
}

function ariaLabelledText(openingTag, labels) {
    const ids = new Set(htmlAttributeValue(openingTag, 'aria-labelledby')
        .split(/\s+/)
        .filter(Boolean));
    return boundedDomText([...ids].map(id => labels.get(id) || ''));
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

function htmlTagHasHiddenAttribute(tag) {
    return /(?:^|\s)hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?(?=\s|\/?>)/i
        .test(tag);
}

function htmlTagIsHidden(tag) {
    return htmlTagIsPersistentlyHidden(tag) || htmlTagVisibilityOverride(tag) === true;
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

function inlineStyleDisplay(style) {
    return cascadedInlineStyleValue(
        style,
        'display',
        /^(?:none|contents|block|inline|run-in|flow-root|list-item|flex|grid|table|table-(?:row|cell|column|caption|row-group|header-group|footer-group|column-group)|inline-(?:block|flex|grid|table)|ruby(?:-base|-text|-base-container|-text-container)?|inherit|initial|revert(?:-layer)?|unset|(?:block|inline)\s+(?:flow|flow-root|flex|grid|ruby)(?:\s+list-item)?)$/i
    );
}

function inlineStyleVisibility(style) {
    return cascadedInlineStyleValue(
        style,
        'visibility',
        /^(?:visible|hidden|collapse|inherit|initial|revert(?:-layer)?|unset)$/i
    );
}

function htmlTagIsPersistentlyHidden(tag, excludeAriaHidden = false) {
    return htmlTagHasHiddenAttribute(tag)
        || inlineStyleDisplay(htmlAttributeValue(tag, 'style')) === 'none'
        || excludeAriaHidden && htmlTagIsAriaHidden(tag);
}

function htmlTagVisibilityOverride(tag) {
    const visibility = inlineStyleVisibility(htmlAttributeValue(tag, 'style'));
    if (['hidden', 'collapse'].includes(visibility)) return true;
    if (['visible', 'initial'].includes(visibility)) return false;
    return null;
}

function htmlOpeningVisibilityState(stack, openingTag, excludeAriaHidden = false) {
    const parent = stack.at(-1);
    const persistentHidden = Boolean(parent?.persistentHidden)
        || htmlTagIsPersistentlyHidden(openingTag, excludeAriaHidden);
    const override = htmlTagVisibilityOverride(openingTag);
    const visibilityHidden = override === null
        ? Boolean(parent?.visibilityHidden)
        : override;
    return {
        persistentHidden,
        visibilityHidden,
        hidden: persistentHidden || visibilityHidden,
    };
}

function lastHtmlStackTagIndex(stack, tag) {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) return index;
    }
    return -1;
}

function updateHtmlVisibilityStack(stack, content, excludeAriaHidden = false) {
    const pattern = /<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    for (const match of content.matchAll(pattern)) {
        const closing = match[1] === '/';
        const tag = match[2].toLowerCase();
        if (closing) {
            const opening = lastHtmlStackTagIndex(stack, tag);
            if (opening !== -1) stack.splice(opening);
            continue;
        }
        if (tag === 'a') {
            const activeAnchor = lastHtmlStackTagIndex(stack, tag);
            if (activeAnchor !== -1) stack.splice(activeAnchor);
        }
        const selfClosing = /\/>\s*$/.test(match[0]) || HTML_VOID_ELEMENTS.has(tag);
        if (selfClosing) continue;
        stack.push({
            tag,
            ...htmlOpeningVisibilityState(stack, match[0], excludeAriaHidden),
        });
    }
}

function htmlElementIsHidden(content, index, openingTag, excludeAriaHidden = false) {
    const stack = [];
    updateHtmlVisibilityStack(stack, content.slice(0, index), excludeAriaHidden);
    return htmlOpeningVisibilityState(stack, openingTag, excludeAriaHidden).hidden;
}

function htmlPriorBlockText(content, boundary, labels) {
    if (boundary <= 0) return '';
    const blocks = content.slice(0, boundary).split(
        /<\/?(?:address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|td|th|tr|ul)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
    );
    return blocks.map(block => compactGovernedText(block, labels)).filter(Boolean).at(-1) || '';
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
            compactGovernedText(rawBefore.slice(beforeBoundary), labels)
        }`.replace(/\s+/g, ' ').trim();
        const accessibleName = ariaLabelledText(openingTag, labels)
            || htmlAttributeText(openingTag, 'aria-label')
            || nestedName
            || htmlAttributeText(openingTag, 'title');
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
            contextAfter: compactGovernedText(
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
    const context = compactGovernedText(visible);
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
        || htmlAttributeText(openingTag, 'aria-label');
    const title = htmlAttributeText(openingTag, 'title');
    let body = opening.slice(anchor.openingEnd);
    const record = (endIndex, autoClosed = false) => {
        const label = combinedHtmlLabel(explicitName, governedHtmlText(body, labels))
            || boundedDomText([title]);
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
            const blockText = compactGovernedText(token.content, htmlLabels);
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
    htmlLabelIsTruncated,
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
