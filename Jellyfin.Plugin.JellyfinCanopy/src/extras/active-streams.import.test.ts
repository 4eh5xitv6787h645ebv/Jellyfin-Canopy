import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const streamsGlobal = JC as typeof JC & {
    activeStreams?: { initialize(): void; destroy(): void };
};

describe('Active Streams feature-module import', () => {
    it('does not publish a facade or register identity work before activation', async () => {
        vi.resetModules();
        streamsGlobal.activeStreams = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');

        await import('./active-streams');

        expect(streamsGlobal.activeStreams).toBeUndefined();
        expect(registerReset).not.toHaveBeenCalled();
        registerReset.mockRestore();
    });

    it('preserves the public facade identity across disable and live re-enable', async () => {
        vi.resetModules();
        const { installActiveStreams } = await import('./active-streams');
        const disposeFirst = installActiveStreams();
        const facade = streamsGlobal.activeStreams;

        disposeFirst();
        const disposeSecond = installActiveStreams();

        expect(streamsGlobal.activeStreams).toBe(facade);
        disposeSecond();
    });
});
