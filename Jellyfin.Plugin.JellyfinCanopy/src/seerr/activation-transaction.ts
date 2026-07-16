export type SeerrCleanup = () => void;
export type SeerrInstaller = () => SeerrCleanup;

/** Reverse-order, exception-contained cleanup ownership for one activation. */
export function createSeerrActivationTransaction(): {
    add(cleanup: SeerrCleanup): void;
    install(installer: SeerrInstaller): void;
    dispose: SeerrCleanup;
} {
    const cleanups: SeerrCleanup[] = [];
    let disposed = false;
    const add = (cleanup: SeerrCleanup): void => {
        if (disposed) {
            try { cleanup(); } catch { /* activation is already retired */ }
            return;
        }
        cleanups.push(cleanup);
    };
    return {
        add,
        install(installer): void {
            add(installer());
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const cleanup of cleanups.splice(0).reverse()) {
                try { cleanup(); } catch { /* continue exact teardown */ }
            }
        },
    };
}
