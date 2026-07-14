import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../core/ui-kit';

describe('request action source token', () => {
    let plugin: ReturnType<typeof vi.fn>;
    let handleRequestAction: typeof import('./data').handleRequestAction;

    beforeEach(async () => {
        vi.resetModules();
        plugin = vi.fn().mockRejectedValue(new Error('stop after request capture'));
        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.core = { api: { plugin } };
        JC.toast = vi.fn();
        ({ handleRequestAction } = await import('./data'));
    });

    function button(token?: string): HTMLButtonElement {
        const card = document.createElement('div');
        card.className = 'jc-request-card';
        card.innerHTML = `
            <button class="jc-request-approve-btn" data-request-id="9"${token ? ` data-source-token="${token}"` : ''}>
                <span class="material-icons">check</span>
            </button>
            <button class="jc-request-decline-btn" data-request-id="9"${token ? ` data-source-token="${token}"` : ''}></button>`;
        return card.querySelector<HTMLButtonElement>('.jc-request-approve-btn')!;
    }

    it('carries the opaque token on the non-retried POST', async () => {
        await handleRequestAction(button('payload.signature+/='), 'approve');

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(plugin).toHaveBeenCalledWith(
            '/arr/requests/9/approve?sourceToken=payload.signature%2B%2F%3D',
            { method: 'POST', skipRetry: true },
        );
    });

    it('does not send an unbound action when the row has no token', async () => {
        await handleRequestAction(button(), 'approve');
        expect(plugin).not.toHaveBeenCalled();
    });
});
