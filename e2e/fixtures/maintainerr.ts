// Hermetic Maintainerr fixture control and bounded request evidence.
//
// The Docker seed owns config.json and the mock server reads it on every
// request. Specs may switch only the named synthetic response mode; they never
// receive a live Maintainerr URL or any upstream credential.
import fs from 'node:fs/promises';
import path from 'node:path';

export type MaintainerrMode =
    | 'happy'
    | 'empty'
    | 'unsupported'
    | 'mismatch'
    | 'slow'
    | 'malformed'
    | 'redirect'
    | 'oversized';

export interface MaintainerrInFlightRow {
    schemaVersion: 1;
    sequence: number;
    method: string;
    path: string;
    query: Record<string, string>;
    mode: MaintainerrMode;
    credentialHeadersPresent: boolean;
}

export interface MaintainerrAuditRow extends MaintainerrInFlightRow {
    status: number;
    aborted: boolean;
}

interface MaintainerrAuditFile {
    schemaVersion: 1;
    requests: MaintainerrAuditRow[];
    inFlight: MaintainerrInFlightRow[];
}

interface FixtureState {
    users: unknown[];
    maintainerr: {
        mode: MaintainerrMode;
        jellyfinMachineId: string;
        itemStatuses: Record<string, {
            excludedFrom: Array<{ label: string; targetPath?: string }>;
            manuallyAddedTo: Array<{ label: string; targetPath?: string }>;
        }>;
    };
    [key: string]: unknown;
}

const MODES = new Set<MaintainerrMode>([
    'happy',
    'empty',
    'unsupported',
    'mismatch',
    'slow',
    'malformed',
    'redirect',
    'oversized',
]);

function mockStateDirectory(): string {
    const ownedState = process.env.JF_E2E_STATE_DIR?.trim();
    return ownedState
        ? path.resolve(ownedState, 'mock-state')
        : path.resolve(__dirname, '../docker/mock-state');
}

function fixturePath(): string {
    return path.join(mockStateDirectory(), 'config.json');
}

function auditPath(): string {
    return path.join(mockStateDirectory(), 'maintainerr-requests.json');
}

async function readFixtureState(): Promise<FixtureState> {
    const parsed = JSON.parse(await fs.readFile(fixturePath(), 'utf8')) as Partial<FixtureState>;
    if (!Array.isArray(parsed.users) || !parsed.maintainerr
        || typeof parsed.maintainerr.jellyfinMachineId !== 'string'
        || typeof parsed.maintainerr.itemStatuses !== 'object') {
        throw new Error('hermetic Maintainerr fixture state is incomplete; run e2e/docker/seed.sh');
    }
    return parsed as FixtureState;
}

async function writeAtomically(destination: string, value: unknown): Promise<void> {
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await fs.rename(temporary, destination);
}

/** Change only the synthetic Maintainerr response mode and return the old mode. */
export async function setMaintainerrMode(mode: MaintainerrMode): Promise<MaintainerrMode> {
    if (!MODES.has(mode)) throw new Error(`unsupported hermetic Maintainerr mode: ${mode}`);
    const state = await readFixtureState();
    const previous = MODES.has(state.maintainerr.mode) ? state.maintainerr.mode : 'happy';
    await writeAtomically(fixturePath(), {
        ...state,
        maintainerr: {
            ...state.maintainerr,
            mode,
        },
    });
    return previous;
}

/** Clear only the bounded, sanitized request ledger owned by the current shard. */
export async function clearMaintainerrAudit(): Promise<void> {
    await writeAtomically(auditPath(), { schemaVersion: 1, requests: [], inFlight: [] });
}

/** Read the current shard's bounded, sanitized Maintainerr request ledger. */
export async function readMaintainerrAudit(): Promise<MaintainerrAuditRow[]> {
    try {
        const parsed = JSON.parse(await fs.readFile(auditPath(), 'utf8')) as Partial<MaintainerrAuditFile>;
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.requests)) {
            throw new Error('invalid hermetic Maintainerr request ledger');
        }
        return parsed.requests;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

/** Read sanitized requests accepted by the fixture but not yet completed. */
export async function readMaintainerrInFlight(): Promise<MaintainerrInFlightRow[]> {
    try {
        const parsed = JSON.parse(await fs.readFile(auditPath(), 'utf8')) as Partial<MaintainerrAuditFile>;
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.inFlight)) {
            throw new Error('invalid hermetic Maintainerr in-flight ledger');
        }
        return parsed.inFlight;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

/** Resolve the seeded item that has a deterministic upstream item-status DTO. */
export async function seededMaintainerrItemId(): Promise<string> {
    const state = await readFixtureState();
    const ids = Object.keys(state.maintainerr.itemStatuses);
    if (ids.length !== 1 || !/^[0-9a-f]{32}$/i.test(ids[0])) {
        throw new Error('hermetic Maintainerr fixture must contain exactly one Jellyfin item id');
    }
    return ids[0];
}
