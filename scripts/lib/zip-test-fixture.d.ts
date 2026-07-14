// Type surface for the zero-dependency ZIP fixture helper used by both Node
// and strict TypeScript test suites.

export interface ZipFixtureFile {
    name: string;
    data?: string;
}

export function writeZipFixture(fixturePath: string, files: ZipFixtureFile[]): string;
