export function completeAcknowledgedMutation(options: {
    verifyAcknowledgement: () => void;
    journalMutation: () => void;
    verifyProductState: () => Promise<void>;
}): Promise<void>;

export function runIndependentRestorations(options: {
    pageCleanup: () => Promise<void>;
    restoreDurableUserState: () => Promise<void>;
    restoreAdministratorConfig: () => Promise<void>;
    timeoutMs?: number;
}): Promise<string[]>;

export function throwAfterRestoration(
    primaryError: unknown,
    restorationFailures: string[],
): void;
