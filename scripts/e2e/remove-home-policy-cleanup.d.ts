export function completeAcknowledgedMutation(options: {
    verifyAcknowledgement: () => void;
    journalMutation: () => void;
    verifyProductState: () => Promise<void>;
}): Promise<void>;

export function runIndependentRestorations(options: {
    pageCleanup: (signal: AbortSignal) => Promise<void>;
    restoreDurableUserState: (signal: AbortSignal) => Promise<void>;
    restoreAdministratorConfig: (signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
}): Promise<string[]>;

export function throwAfterRestoration(
    primaryError: unknown,
    restorationFailures: string[],
): void;
