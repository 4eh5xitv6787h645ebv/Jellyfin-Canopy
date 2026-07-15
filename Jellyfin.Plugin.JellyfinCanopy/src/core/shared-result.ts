/**
 * Lets one feature lifecycle stop waiting for shared work without cancelling
 * the identity-owned transport or affecting other same-key waiters.
 */
export function waitForSharedResult<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
        // The shared transport was already started before this waiter observed
        // cancellation. Keep its rejection observed even when no waiter remains.
        void promise.catch(() => undefined);
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(
            value => {
                cleanup();
                resolve(value);
            },
            error => {
                cleanup();
                reject(error instanceof Error ? error : new Error('Shared result rejected'));
            }
        );
    });
}
