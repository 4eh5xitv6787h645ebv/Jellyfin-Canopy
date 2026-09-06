import { expect, type Page, type Response as BrowserResponse } from 'playwright/test';

/**
 * Chromium may leave Playwright's body read pending for a no-store response
 * whose native fetch consumer only inspects its status. Read one real response
 * clone without delaying or replacing the Response delivered to that consumer.
 */
export async function withObservedJsonResponse<T>(
    page: Page,
    expectedUrl: string,
    run: (read: (response: BrowserResponse) => Promise<unknown>) => Promise<T>,
): Promise<T> {
    const observer = await page.evaluateHandle((url) => {
        const originalFetch = window.fetch;
        let disposed = false;
        let claimed = false;
        let state: {
            phase: 'pending' | 'complete' | 'error';
            error?: string;
            url?: string;
            status?: number;
            etag?: string | null;
            body?: unknown;
        } = { phase: 'pending' };
        const fail = (stage: string): void => {
            if (!disposed) state = { phase: 'error', error: stage };
        };
        const restore = (): void => {
            if (window.fetch === observeFetch) window.fetch = originalFetch;
        };
        const observeFetch: typeof window.fetch = function (this: unknown, input, init) {
            let requestUrl: string;
            try {
                requestUrl = new URL(
                    input instanceof Request ? input.url : String(input),
                    document.baseURI,
                ).href;
            } catch {
                return originalFetch.call(this, input, init);
            }
            const method = init?.method
                ?? (input instanceof Request ? input.method : 'GET');
            if (disposed || claimed || requestUrl !== url || method.toUpperCase() !== 'POST') {
                return originalFetch.call(this, input, init);
            }
            // Claim once, before another request can enter this wrapper.
            claimed = true;
            restore();
            let fetching: Promise<Response>;
            try {
                fetching = originalFetch.call(this, input, init);
            } catch (error) {
                fail('native fetch threw');
                throw error;
            }
            return fetching.then((response) => {
                try {
                    void response.clone().json().then((body: unknown) => {
                        if (!disposed) state = {
                            phase: 'complete',
                            url: response.url,
                            status: response.status,
                            etag: response.headers.get('etag'),
                            body,
                        };
                    }, () => fail('response clone JSON read failed'));
                } catch {
                    fail('response clone failed');
                }
                return response;
            }, (error: unknown) => {
                fail('native fetch rejected');
                throw error;
            });
        };
        window.fetch = observeFetch;
        return {
            snapshot: () => state,
            dispose: () => {
                disposed = true;
                restore();
                state = { phase: 'pending' };
            },
        };
    }, expectedUrl);

    let failed = false;
    let primaryError: unknown;
    try {
        return await run(async (response) => {
            await expect.poll(
                () => observer.evaluate(value => value.snapshot().phase),
                { timeout: 30_000, message: 'the exact browser POST response clone settles' },
            ).not.toBe('pending');
            const observed = await observer.evaluate(value => value.snapshot());
            expect(observed.error, 'browser response observation succeeds').toBeUndefined();
            expect(observed.url, 'observer uses the real browser response URL').toBe(response.url());
            expect(observed.status).toBe(response.status());
            expect(observed.etag).toBe(response.headers()['etag'] ?? null);
            return observed.body;
        });
    } catch (error) {
        failed = true;
        primaryError = error;
        throw error;
    } finally {
        const cleanupErrors: unknown[] = [];
        try {
            await observer.evaluate(value => value.dispose());
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await observer.dispose();
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (cleanupErrors.length) {
            throw new AggregateError(
                [...(failed ? [primaryError] : []), ...cleanupErrors],
                'browser response observer cleanup failed',
            );
        }
    }
}
