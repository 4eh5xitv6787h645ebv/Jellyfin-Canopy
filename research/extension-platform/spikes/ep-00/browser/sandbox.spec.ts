// EP-00.2 — browser spike for ADR-0007.
//
// Deliberately NOT in e2e/: this is throwaway research, it must never join the
// required suite, and it asserts things about the *platform design* rather than
// about shipped behaviour. Run it with ../run-web-spike.sh.
//
// It answers the questions ADR-0007 could not:
//   1. do Canopy's injection primitives actually support a declarative slot?
//   2. is mounting idempotent, and does teardown really tear down?
//   3. can two contributions coexist without colliding?
//   4. what does Jellyfin 12 actually send for CSP?
//   5. does an opaque-origin iframe deny host DOM, storage and the token?
//   6. can a postMessage broker distinguish frames by source?
import { test, expect, type Page } from 'playwright/test';

const ADMIN_USER = process.env.JF_ADMIN_USER || 'jc_arradmin';
const ADMIN_PASS = process.env.JF_ADMIN_PASS || 'Test669Pw!x';

/** Findings accumulate here and are printed as the run's evidence. */
const findings: Record<string, unknown> = {};

async function login(page: Page): Promise<void> {
    await page.goto('/web/index.html');
    // The web client creates window.ApiClient asynchronously; calling before it
    // exists fails intermittently and looks like an auth problem.
    await page.waitForFunction(
        () => typeof (window as any).ApiClient?.authenticateUserByName === 'function',
        null,
        { timeout: 120_000 },
    );
    await page.evaluate(
        async ([user, pass]) => {
            const client = (window as any).ApiClient;
            await client.authenticateUserByName(user, pass);
        },
        [ADMIN_USER, ADMIN_PASS],
    );
    await page.goto('/web/index.html#/home.html');
    await page.waitForFunction(() => (window as any).JellyfinCanopy?.initialized === true, null, {
        timeout: 120_000,
    });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
    findings.startedAt = new Date().toISOString();
});

test.afterAll(() => {
    // The runner greps for this block.
    console.log('\n===EP00-WEB-FINDINGS===');
    console.log(JSON.stringify(findings, null, 2));
    console.log('===END-EP00-WEB-FINDINGS===\n');
});

test('CSP and the shape of the facade', async ({ page }) => {
    const headers: Record<string, string> = {};
    page.on('response', (response) => {
        if (response.url().includes('/web/index.html')) {
            Object.assign(headers, response.headers());
        }
    });

    await login(page);

    findings.csp = {
        contentSecurityPolicy: headers['content-security-policy'] ?? null,
        xFrameOptions: headers['x-frame-options'] ?? null,
        // The absence of a CSP is itself the finding: it means an opaque-origin
        // iframe is the only isolation an untrusted contribution would get.
        note: headers['content-security-policy']
            ? 'a CSP is served; the broker must be designed within it'
            : 'NO CSP served for the app shell',
    };

    findings.facade = await page.evaluate(() => {
        const jc = (window as any).JellyfinCanopy;
        const core = jc?.core ?? {};
        return {
            present: Boolean(jc),
            initialized: jc?.initialized === true,
            // ADR-0007 claims the facade is frozen only at compile time. Check it.
            rootIsFrozen: Object.isFrozen(jc),
            coreIsFrozen: Object.isFrozen(core),
            // Can arbitrary page script replace a facade member?
            rootIsWritable: (() => {
                const original = jc.escapeHtml;
                try {
                    jc.escapeHtml = () => 'hijacked';
                    const hijacked = jc.escapeHtml('x') === 'hijacked';
                    jc.escapeHtml = original;
                    return hijacked;
                } catch {
                    return false;
                }
            })(),
            hasVersionField: Object.keys(jc).some((k) => /apiversion|platformversion/i.test(k)),
            pluginVersion: jc?.pluginVersion ?? null,
            corePrimitives: {
                ensureInjected: typeof core.dom?.ensureInjected,
                lifecycle: typeof core.lifecycle?.register,
                navigation: typeof core.navigation?.onNavigate,
                ui: typeof core.ui?.toast,
                live: typeof core.live?.on,
            },
        };
    });

    expect(findings.facade).toMatchObject({ present: true, initialized: true });
});

test('a declarative descriptor renders into a semantic slot, idempotently', async ({ page }) => {
    await login(page);

    findings.slotRender = await page.evaluate(async () => {
        const jc = (window as any).JellyfinCanopy;
        const dom = jc.core.dom;

        // A v1-shaped descriptor: no markup, no selectors, no script. The host
        // decides how each field becomes DOM.
        const descriptor = {
            slot: 'item-detail-action',
            id: 'ep00.demo.action',
            label: 'Request <img src=x onerror=alert(1)>',
            icon: 'download',
            action: { kind: 'invoke', token: 'opaque-token-placeholder' },
        };

        const anchor = () =>
            (document.querySelector('.skinHeader') as HTMLElement | null) ?? document.body;

        // The primitive's contract: buildFn ATTACHES the node and returns it (the
        // injector only stamps data-jc-key). Returning a detached element silently
        // renders nothing — worth knowing before EP-07 builds on it.
        const render = () =>
            dom.ensureInjected(
                'ep00-demo-' + descriptor.id,
                anchor,
                (host: HTMLElement) => {
                    const button = document.createElement('button');
                    button.dataset.ep00 = descriptor.id;
                    // Host-owned rendering: the label is TEXT, never markup.
                    button.textContent = descriptor.label;
                    host.appendChild(button);
                    return button;
                },
            );

        render();
        render();
        render();
        await new Promise((r) => setTimeout(r, 400));

        const nodes = document.querySelectorAll('[data-ep00="ep00.demo.action"]');
        const rendered = nodes[0] as HTMLElement | undefined;

        const handle = render();
        handle.remove();
        await new Promise((r) => setTimeout(r, 200));
        const afterRemove = document.querySelectorAll('[data-ep00="ep00.demo.action"]').length;

        return {
            mountCallsMade: 3,
            nodesRendered: nodes.length,
            nodesAfterRemove: afterRemove,
            teardownRemovesNode: afterRemove === 0,
            idempotent: nodes.length === 1,
            // The hostile label must appear as text, with no element created.
            labelRenderedAsText: rendered?.textContent === descriptor.label,
            injectedElementCount: rendered?.querySelectorAll('*').length ?? -1,
            scriptExecuted: Boolean((window as any).__ep00Pwned),
        };
    });

    expect(findings.slotRender).toMatchObject({
        idempotent: true,
        labelRenderedAsText: true,
        injectedElementCount: 0,
        scriptExecuted: false,
    });
});

test('two contributions coexist without colliding', async ({ page }) => {
    await login(page);

    findings.coexistence = await page.evaluate(async () => {
        const dom = (window as any).JellyfinCanopy.core.dom;
        const anchor = () =>
            (document.querySelector('.skinHeader') as HTMLElement | null) ?? document.body;

        for (const id of ['vendor-a.badge', 'vendor-b.badge']) {
            dom.ensureInjected('ep00-co-' + id, anchor, (host: HTMLElement) => {
                const span = document.createElement('span');
                span.dataset.ep00co = id;
                span.textContent = id;
                host.appendChild(span);
                return span;
            });
        }

        await new Promise((r) => setTimeout(r, 400));

        return {
            a: document.querySelectorAll('[data-ep00co="vendor-a.badge"]').length,
            b: document.querySelectorAll('[data-ep00co="vendor-b.badge"]').length,
            bothPresent:
                document.querySelectorAll('[data-ep00co="vendor-a.badge"]').length === 1 &&
                document.querySelectorAll('[data-ep00co="vendor-b.badge"]').length === 1,
        };
    });

    expect(findings.coexistence).toMatchObject({ bothPresent: true });
});

test('an opaque-origin frame is denied the DOM, storage and the token', async ({ page }) => {
    await login(page);

    findings.sandbox = await page.evaluate(async () => {
        const frame = document.createElement('iframe');
        // No allow-same-origin: the frame gets an opaque origin, so same-origin
        // access is denied even though the document came from us.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.display = 'none';
        frame.srcdoc = `
            <script>
              const report = (payload) => parent.postMessage(payload, '*');
              window.addEventListener('message', (e) => {
                report({ kind: 'echo', gotFromParent: e.data, origin: e.origin });
              });
              let parentDomReadable = false, storageReadable = false, tokenReadable = false;
              try { parentDomReadable = !!parent.document.body; } catch { }
              try { storageReadable = !!parent.localStorage.length; } catch { }
              try { tokenReadable = !!parent.ApiClient.accessToken(); } catch { }
              report({ kind: 'probe', origin: location.origin, parentDomReadable, storageReadable, tokenReadable });
            </script>`;

        const messages: any[] = [];
        const received = new Promise<void>((resolve) => {
            const onMessage = (event: MessageEvent) => {
                messages.push({
                    origin: event.origin,
                    isFromOurFrame: event.source === frame.contentWindow,
                    data: event.data,
                });
                if (messages.length >= 2) {
                    window.removeEventListener('message', onMessage);
                    resolve();
                }
            };
            window.addEventListener('message', onMessage);
        });

        document.body.appendChild(frame);

        // A capability-filtered broker: only messages whose source is a frame we
        // own are considered, and the reply carries no credential.
        await new Promise((r) => setTimeout(r, 300));
        frame.contentWindow?.postMessage({ capability: 'contribution.refresh' }, '*');

        await Promise.race([received, new Promise((r) => setTimeout(r, 4000))]);

        let hostCanReachIntoFrame = false;
        try {
            hostCanReachIntoFrame = Boolean(frame.contentWindow?.document?.body);
        } catch {
            hostCanReachIntoFrame = false;
        }

        const probe = messages.find((m) => m.data?.kind === 'probe');
        const echo = messages.find((m) => m.data?.kind === 'echo');
        frame.remove();

        return {
            messagesReceived: messages.length,
            frameOrigin: probe?.data?.origin ?? null,
            frameOriginIsOpaque: probe?.data?.origin === 'null',
            // The three things the frame must NOT be able to do.
            frameReadParentDom: probe?.data?.parentDomReadable ?? null,
            frameReadStorage: probe?.data?.storageReadable ?? null,
            frameReadToken: probe?.data?.tokenReadable ?? null,
            // The host equally cannot reach into it, which is what makes the
            // postMessage broker the only channel.
            hostCanReachIntoFrame,
            // Every inbound message is attributable to a specific frame, which is
            // what a capability filter needs.
            everyMessageAttributable: messages.every((m) => m.isFromOurFrame === true),
            inboundOrigin: probe?.origin ?? null,
            brokerDeliveredToFrame: Boolean(echo),
        };
    });

    expect(findings.sandbox).toMatchObject({
        frameOriginIsOpaque: true,
        frameReadParentDom: false,
        frameReadStorage: false,
        frameReadToken: false,
        hostCanReachIntoFrame: false,
        everyMessageAttributable: true,
    });
});
