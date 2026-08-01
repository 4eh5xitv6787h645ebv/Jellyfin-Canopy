import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from './arr-globals';
import { notifyArrLinkError } from './arr-links';

describe('arr-links urgent notifications', () => {
    const notify = vi.fn();

    beforeEach(() => {
        notify.mockReset();
        JC.core.ui = {
            ...(JC.core.ui || {}),
            notify,
        } as typeof JC.core.ui;
        JC.toast = vi.fn();
    });

    it('uses safe typed assertive copy for dynamic integration failures', () => {
        notifyArrLinkError('<img src=x onerror=alert(1)> failed', 'arr-links:test');

        expect(notify).toHaveBeenCalledWith({
            message: '<img src=x onerror=alert(1)> failed',
            severity: 'error',
            duration: 8000,
            dedupeKey: 'arr-links:test',
        });
        expect(JC.toast).not.toHaveBeenCalled();
    });

    it('does not turn notification backpressure into an integration failure', () => {
        notify.mockImplementation(() => { throw new Error('notification capacity full'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => notifyArrLinkError('Arr unavailable', 'arr-links:full')).not.toThrow();
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('notification rejected'),
            expect.any(Error)
        );
    });
});
