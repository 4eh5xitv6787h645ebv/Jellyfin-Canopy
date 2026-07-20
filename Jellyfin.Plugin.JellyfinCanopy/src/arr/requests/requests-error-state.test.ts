// Unit tests for the Requests-page error state (CRIT-2 / W4-ERR-1, W4-ERR-2).
//
// A backend failure (e.g. the requests proxy's 502 when Seerr is unreachable)
// must drive an explicit ERROR state, not the "No requests found" empty state,
// and a total downloads-fetch failure must toast once instead of silently
// showing "No active downloads".
import { describe, expect, it, beforeEach, vi } from 'vitest';
// ui-kit installs the real JC.escapeHtml (the setup stub is a no-op) which the
// render modules capture at import.
import '../../core/ui-kit';

interface HttpErrorLike extends Error { status?: number; responseJSON?: unknown; }
function httpError(status: number, message: string): HttpErrorLike {
    const e = new Error(`HTTP ${status}`) as HttpErrorLike;
    e.status = status;
    e.responseJSON = { message };
    return e;
}

describe('requests page error state', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let toast: ReturnType<typeof vi.fn>;
    let data: typeof import('./data');
    let render: typeof import('./render');

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        plugin = vi.fn();
        toast = vi.fn();
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
        JC.pluginConfig = { SeerrEnabled: true, ShowDownloadsInRequests: true };
        JC.t = (k: string) => k;
        JC.toast = toast;
        // Import AFTER JC.core.api is set — data.ts captures `JC.core.api` at eval.
        data = await import('./data');
        render = await import('./render');
    });

    it('fetchRequests flags requestsError on a structured 502 and renders the error state', async () => {
        plugin.mockRejectedValue(httpError(502, 'Seerr unreachable'));

        await data.fetchRequests();

        expect(data.state.requestsError).toBe(true);
        expect(data.state.requests.length).toBe(0);

        data.state.isLoading = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('requests_load_error');
        expect(container.innerHTML).not.toContain('requests_no_requests_found');
        expect(container.querySelector('.jc-requests-tab.active')?.getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelector('.jc-refresh-btn')?.getAttribute('aria-label')).toBe('requests_downloads');
    });

    it('a successful fetch clears requestsError so the empty state can show again', async () => {
        data.state.requestsError = true;
        plugin.mockResolvedValue({ requests: [], totalPages: 1 });

        await data.fetchRequests();

        expect(data.state.requestsError).toBe(false);

        data.state.isLoading = false;
        const container = document.createElement('div');
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('requests_no_requests_found');
        expect(container.innerHTML).not.toContain('requests_load_error');
    });

    it('a total downloads-fetch failure toasts once instead of rendering an empty queue silently', async () => {
        // Every plugin call rejects: fetchDownloads toasts (the channel under
        // test), fetchRequests only flags requestsError, fetchIssues short-circuits.
        plugin.mockRejectedValue(new Error('network down'));

        await data.loadAllData();

        expect(data.state.downloads.length).toBe(0);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(String(toast.mock.calls[0][0])).toContain('downloads_load_error');
    });

    it('does not repaint a retained container owned by the previous identity', () => {
        const container = document.createElement('div');
        container.innerHTML = '<span>account-a-sentinel</span>';
        document.body.appendChild(container);
        window.JellyfinCanopy.identity.own(container);
        render.setActiveContainer(container);

        const epoch = window.JellyfinCanopy.identity.getEpoch();
        window.JellyfinCanopy.identity.transition('requests-test-server', `requests-user-${epoch}`, 'test-account-switch');
        render.renderPage();
        render.setActiveContainer(null);

        expect(container.innerHTML).toContain('account-a-sentinel');
        expect(container.innerHTML).not.toContain('requests_no_requests_found');
    });
});
