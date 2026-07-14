import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { registerPage } from './registry';
import { initEntryPoints } from './entry-points';

describe('page entry-point identity lifecycle', () => {
    it('removes A chrome synchronously and does not retain an A-only link for B', async () => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'entry-test-start');
        let enabled = true;
        let language = 'A';
        JC.t = () => `Calendar ${language}`;
        registerPage({
            id: 'identity-entry',
            route: '/identity-entry',
            titleKey: 'identity_entry',
            titleFallback: 'Identity entry',
            icon: 'event',
            isEnabled: () => enabled,
            render: vi.fn(),
        });
        const sidebar = document.createElement('div');
        sidebar.className = 'mainDrawer-scrollContainer';
        Object.defineProperty(sidebar, 'offsetParent', { get: () => document.body });
        document.body.appendChild(sidebar);
        initEntryPoints();

        const retainedA = document.getElementById('jcPageLink-identity-entry') as HTMLAnchorElement;
        expect(retainedA.textContent).toContain('Calendar A');
        const hashBefore = window.location.hash;

        enabled = false;
        language = 'B';
        const contextB = JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(document.getElementById('jcPageLink-identity-entry')).toBeNull();

        await JC.identity.activate(contextB);
        expect(document.getElementById('jcPageLink-identity-entry')).toBeNull();
        retainedA.click();
        expect(window.location.hash).toBe(hashBefore);
        JC.core.dom!.removeBodySubscriber('jc-pages-entries');
    });
});
