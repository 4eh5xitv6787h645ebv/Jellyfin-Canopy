// Type surface for scripts/check-dotnet-coverage.js (a zero-dependency CJS
// build script). Declared here so the vitest suite can import measurePackage
// under the strict src/ tsconfig (types: [], no allowJs).

export function measurePackage(xml: string): { valid: number; covered: number } | null;
