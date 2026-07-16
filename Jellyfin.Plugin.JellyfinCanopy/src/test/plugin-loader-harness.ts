import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');
const PLUGIN_JS_PATH = SRC_ROOT.replace(/src\/$/, 'js/') + 'plugin.js';
const SOURCE = ts.sys.readFile(PLUGIN_JS_PATH) ?? '';

function extractFunctionSource(name: string): string {
    const start = SOURCE.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in plugin.js`);
    const braceStart = SOURCE.indexOf('{', start);
    if (braceStart < 0) throw new Error(`${name} body not found in plugin.js`);
    let depth = 0;
    for (let i = braceStart; i < SOURCE.length; i++) {
        const ch = SOURCE[i];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return SOURCE.slice(start, i + 1);
    }
    throw new Error(`${name} body is unterminated in plugin.js`);
}

export type UserFileCaseTransform = (
    fileName: string,
    value: unknown,
    direction: 'load' | 'save',
) => unknown;

/** Evaluates the exact schema-transform implementation shipped in plugin.js. */
export function loadUserFileCaseTransform(): UserFileCaseTransform {
    const sources = [
        'transformObjectKeys',
        'toCamelCase',
        'toPascalCase',
        'userFileCaseOptions',
        'transformUserFileCase',
    ].map(extractFunctionSource).join('\n');
    const evaluated: unknown = eval(`(() => { ${sources}\nreturn transformUserFileCase; })()`);
    return evaluated as UserFileCaseTransform;
}
