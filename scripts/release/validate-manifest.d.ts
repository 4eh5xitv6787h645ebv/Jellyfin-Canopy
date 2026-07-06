// Type surface for scripts/release/validate-manifest.js (a zero-dependency CJS
// build script). Declared here so the vitest suite can import it under the
// strict src/ tsconfig (types: [], no allowJs).

export function validateManifest(data: unknown): { errors: string[]; warnings: string[] };
export function verifyChecksums(data: unknown, assetsDir: string): { errors: string[] };
export function compareVersions(a: string, b: string): number;
export function expectedZipName(targetAbi: string): string;
