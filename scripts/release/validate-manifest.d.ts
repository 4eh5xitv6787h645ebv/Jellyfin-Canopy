// Type surface for scripts/release/validate-manifest.js (a zero-dependency CJS
// build script). Declared here so the vitest suite can import it under the
// strict src/ tsconfig (types: [], no allowJs).

export const MAX_CHANGELOG_BYTES: number;
export const MAX_CHANGELOG_LINES: number;
export const MAX_MANIFEST_BYTES: number;
export function validateManifest(
    data: unknown,
    options?: { manifestBytes?: number; enforcePayloadBudgets?: boolean },
): { errors: string[]; warnings: string[] };
export function verifyChecksums(data: unknown, assetsDir: string): { errors: string[] };
export function compareVersions(a: string, b: string): number;
export function expectedZipName(targetAbi: string): string;
