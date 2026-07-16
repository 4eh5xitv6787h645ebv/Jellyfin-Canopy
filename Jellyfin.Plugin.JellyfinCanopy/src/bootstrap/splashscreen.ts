// src/bootstrap/splashscreen.ts
//
// Out-of-band loader: compiled to its own dist/splashscreen.js IIFE and served
// separately (js/plugin.js loads it early, before initialize()). It is NOT part
// of the authenticated ESM runtime — it must run first so the splash covers the
// whole boot.
//
// Attaches JC.initializeSplashScreen / JC.hideSplashScreen to the shared
// namespace. Behaviour is identical to the former js/others/splashscreen.js;
// this is a typed port.

(function () {
    'use strict';

    const CONFIG = {
        loadingCheckInterval: 100,
        fadeOutDuration: 400,         // Duration of fade out animation (ms)
        progressUpdateInterval: 150,  // How often to update progress bar (ms)
        hardTimeout: 20000,           // Max time before force-hiding splash (ms)
        removalInterval: 100,
        removalDuration: 5000
    };

    const READY_SELECTORS = [
        '.manualLoginForm',
        '#mainAnimatedPage',
        '.homeSectionsContainer',
        '.pageContainer',
        '.slides-container',
        '.backdrop-container',
        'customTabButton_0',
        '.editorsChoiceItemBanner'
    ];

    let splashElement: HTMLDivElement | null = null;
    let styleElement: HTMLStyleElement | null = null;
    let permanentBlockStyle: HTMLStyleElement | null = null;
    let readyObserver: MutationObserver | null = null;
    let mediaBarBlocker: MutationObserver | null = null;
    let progressTimer: number | null = null;
    let hardTimeout: number | null = null;
    let isHidden = false;
    // Named refs so the ready listeners added in startReadyObserver are removable
    // on the hide path (they were anonymous closures removed by nothing before).
    let onHashChangeReady: (() => void) | null = null;
    let onVisibilityReady: (() => void) | null = null;

    /**
     * Installs preemptive CSS to hide competing splash screens before rendering
     */
    function installPreemptiveStyles(): void {
        try {
            const style = document.createElement('style');
            style.id = 'jc-preempt-styles';
            style.textContent = `
                html.jc-splash-booting .bar-loading,
                html.jc-splash-booting #page-loader,
                html.jc-splash-booting #splashscreen,
                html.jc-splash-booting .splash,
                html.jc-splash-booting [data-plugin-splash] {
                    display: none !important;
                }
            `;
            document.documentElement.classList.add('jc-splash-booting');
            (document.head || document.documentElement).appendChild(style);
        } catch (error) {
            console.warn('🪼 Jellyfin Canopy: Failed to install preemptive styles', error);
        }
    }

    /**
     * Installs permanent CSS block for media-bar and other competing splash screens
     */
    function installPermanentBlock(): void {
        if (permanentBlockStyle) {
            return;
        }

        try {
            permanentBlockStyle = document.createElement('style');
            permanentBlockStyle.id = 'jc-permanent-block';
            permanentBlockStyle.textContent = `
                #page-loader,
                .bar-loading:not(.jc-loading),
                #splashscreen:not(.jc-loading),
                .splash:not(.jc-loading),
                [data-plugin-splash]:not(.jc-loading) {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
            `;
            document.head.appendChild(permanentBlockStyle);
            console.log('🪼 Jellyfin Canopy: Permanent splash block installed');
        } catch (error) {
            console.warn('🪼 Jellyfin Canopy: Failed to install permanent block', error);
        }
    }

    /**
     * Removes any media-bar splash elements from the DOM
     */
    function removeMediaBarSplash(): void {
        const mediaBarElements = document.querySelectorAll('#page-loader, .bar-loading:not(.jc-loading)');
        mediaBarElements.forEach(element => {
            if (element && element.parentNode) {
                console.log('🪼 Jellyfin Canopy: Removing media-bar splash element');
                element.remove();
            }
        });
    }

    /**
     * Starts a MutationObserver to block media-bar injection attempts
     */
    function startMediaBarBlocker(): void {
        if (mediaBarBlocker) {
            return;
        }

        mediaBarBlocker = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        if (node.id === 'page-loader' ||
                            (node.classList.contains('bar-loading') && !node.classList.contains('jc-loading'))) {
                            console.log('🪼 Jellyfin Canopy: Blocking media-bar splash attempt');
                            node.remove();
                        }
                    }
                });
            });
        });
        mediaBarBlocker.observe(document.body, {
            childList: true,
            subtree: false
        });
    }

    /**
     * Checks if an element is visible
     */
    function isElementShown(element: Element | null): boolean {
        return !!(element && element instanceof HTMLElement && element.offsetParent !== null);
    }

    /**
     * Checks if the Jellyfin UI is ready for interaction
     */
    function isUIReady(): boolean {
        for (const selector of READY_SELECTORS) {
            const element = document.querySelector(selector);
            if (isElementShown(element) || (element && selector === '#mainAnimatedPage')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Hides the splash screen with animation
     * @param reason - Reason for hiding
     */
    function hideSplashScreen(reason?: string): void {
        if (isHidden) {
            return;
        }
        isHidden = true;

        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
        if (hardTimeout) {
            clearTimeout(hardTimeout);
            hardTimeout = null;
        }
        if (readyObserver) {
            readyObserver.disconnect();
            readyObserver = null;
        }
        // Tear down the media-bar blocker + the ready listeners on the NORMAL
        // hide path too (previously only cleanup() — the splash-disabled branch —
        // did this, so the running path leaked them). The post-hide media-bar
        // sweep is covered by the removalInterval below.
        if (mediaBarBlocker) {
            mediaBarBlocker.disconnect();
            mediaBarBlocker = null;
        }
        if (onHashChangeReady) {
            window.removeEventListener('hashchange', onHashChangeReady);
            onHashChangeReady = null;
        }
        if (onVisibilityReady) {
            document.removeEventListener('visibilitychange', onVisibilityReady);
            onVisibilityReady = null;
        }

        const progressBar = document.getElementById('jc-progress-bar');
        const unfilledBar = document.getElementById('jc-unfilled-bar');

        const completeRemoval = () => {
            if (splashElement) {
                splashElement.style.opacity = '0';
            }

            setTimeout(() => {
                if (splashElement) {
                    splashElement.remove();
                    splashElement = null;
                }
                if (styleElement) {
                    styleElement.remove();
                    styleElement = null;
                }

                document.body.classList.remove('jc-splash-active');

                const removalInterval = setInterval(() => {
                    removeMediaBarSplash();
                }, CONFIG.removalInterval);

                setTimeout(() => {
                    clearInterval(removalInterval);
                }, CONFIG.removalDuration);

                if (reason) {
                    console.log(`🪼 Jellyfin Canopy: Splash screen hidden → ${reason}`);
                }
            }, CONFIG.fadeOutDuration);
        };

        if (progressBar && unfilledBar) {
            progressBar.style.transition = `width 300ms ease-in-out`;
            progressBar.style.width = '100%';
            unfilledBar.style.width = '0%';
            setTimeout(completeRemoval, 300);
        } else {
            completeRemoval();
        }
    }

    /**
     * Creates and displays the splash screen
     */
    function createSplashScreen(): void {
        if (splashElement) {
            return;
        }

        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();

        const css = `
            body.jc-splash-active .bar-loading:not(.jc-loading) { display: none !important; }
            body.jc-splash-active #page-loader { display: none !important; }
            .jc-loading {
                z-index: 99999999 !important;
                position: fixed;
                inset: 0;
                background: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 1;
                transition: opacity 0.4s ease-in-out;
                overflow: hidden;
            }
            .jc-loader-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 20px;
                width: 250px;
            }
            .jc-loading h1 {
                width: 250px;
                height: 250px;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 0;
            }
            .jc-loading h1 img {
                width: 250px;
                max-height: 250px;
                object-fit: contain;
                opacity: 1;
                transition: opacity 0.5s ease-in-out;
            }
            .jc-progress {
                width: 200px;
                height: 6px;
                display: flex;
                align-items: center;
                position: relative;
            }
            #jc-progress-bar {
                height: 5px;
                background: #fff;
                border-radius: 2px;
                width: 0;
            }
            .jc-gap {
                width: 6px;
                height: 5px;
                flex-shrink: 0;
            }
            #jc-unfilled-bar {
                height: 5px;
                background: #686868;
                border-radius: 2px;
                flex-grow: 1;
            }
        `;

        styleElement = document.createElement('style');
        styleElement.id = 'jc-splash-styles';
        styleElement.textContent = css;
        document.head.appendChild(styleElement);

        const pluginConfig = window.JellyfinCanopy?.pluginConfig || {};
        const imageUrl = (pluginConfig.SplashScreenImageUrl as string) || '/web/assets/img/banner-light.png';
        // Local copy of core/ui-kit escapeHtml: this file is an out-of-band
        // IIFE that must not import the main-bundle module tree.
        const escapedImageUrl = imageUrl
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        splashElement = document.createElement('div');
        splashElement.className = 'jc-loading';
        splashElement.innerHTML = `
            <div class="jc-loader-content">
                <h1><img src="${escapedImageUrl}" alt="Server Logo" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"></h1>
                <div class="jc-progress">
                    <div id="jc-progress-bar"></div>
                    <div class="jc-gap"></div>
                    <div id="jc-unfilled-bar"></div>
                </div>
            </div>
        `;
        document.body.appendChild(splashElement);

        startProgressAnimation();
        startReadyObserver();

        hardTimeout = setTimeout(() => {
            hideSplashScreen('hard timeout 20s');
        }, CONFIG.hardTimeout);
    }

    /**
     * Starts the progress bar animation
     */
    function startProgressAnimation(): void {
        const progressBar = document.getElementById('jc-progress-bar');
        const unfilledBar = document.getElementById('jc-unfilled-bar');

        if (!progressBar || !unfilledBar) {
            return;
        }

        let progress = 0;
        let lastIncrement = 5;

        progressTimer = setInterval(() => {
            if (progress >= 95) {
                return;
            }

            lastIncrement = Math.max(0.5, lastIncrement * 0.98);
            const increment = lastIncrement * (0.8 + Math.random() * 0.4);
            progress = Math.min(95, progress + increment);

            progressBar.style.width = progress + '%';
            unfilledBar.style.width = (100 - progress) + '%';
        }, CONFIG.progressUpdateInterval);
    }

    /**
     * Starts observing the DOM for UI ready state
     */
    function startReadyObserver(): void {
        if (readyObserver) {
            return;
        }

        if (isUIReady()) {
            hideSplashScreen('UI already ready');
            return;
        }

        const bodyCallback = () => {
            removeMediaBarSplash();

            if (document.querySelector('.bar-loading:not(.jc-loading)')) {
                document.body.classList.add('jc-splash-active');
            }

            if (isUIReady()) {
                hideSplashScreen('core UI detected');
            }
        };
        const obs = new MutationObserver(bodyCallback);
        obs.observe(document.body, { childList: true, subtree: true });
        readyObserver = obs;

        onHashChangeReady = () => {
            if (isUIReady()) {
                hideSplashScreen('hashchange ready');
            }
        };
        window.addEventListener('hashchange', onHashChangeReady);

        onVisibilityReady = () => {
            if (!document.hidden && isUIReady()) {
                hideSplashScreen('visibilitychange ready');
            }
        };
        document.addEventListener('visibilitychange', onVisibilityReady);
    }

    /**
     * Cleanup function to remove all blocking styles
     */
    function cleanup(): void {
        document.documentElement.classList.remove('jc-splash-booting');

        const preemptStyle = document.getElementById('jc-preempt-styles');
        if (preemptStyle) {
            preemptStyle.remove();
        }

        if (permanentBlockStyle) {
            permanentBlockStyle.remove();
            permanentBlockStyle = null;
        }

        if (mediaBarBlocker) {
            mediaBarBlocker.disconnect();
            mediaBarBlocker = null;
        }
    }

    /**
     * Initializes the splash screen
     */
    function initializeSplashScreen(): void {
        const pluginConfig = window.JellyfinCanopy?.pluginConfig || {};

        if (!pluginConfig.EnableCustomSplashScreen) {
            cleanup();
            console.log('🪼 Jellyfin Canopy: Custom splash screen disabled');
            return;
        }

        document.body.classList.add('jc-splash-active');
        document.documentElement.classList.remove('jc-splash-booting');

        const preemptStyle = document.getElementById('jc-preempt-styles');
        if (preemptStyle) {
            preemptStyle.remove();
        }

        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();

        createSplashScreen();

        console.log('🪼 Jellyfin Canopy: Splash screen initialized');
    }

    /**
     * Hide splash screen
     */
    function publicHideSplashScreen(): void {
        hideSplashScreen('requested by plugin.js');
    }

    // Install preemptive styles immediately
    installPreemptiveStyles();

    // Export functions to global namespace
    window.JellyfinCanopy.initializeSplashScreen = initializeSplashScreen;
    window.JellyfinCanopy.hideSplashScreen = publicHideSplashScreen;

    console.log('🪼 Jellyfin Canopy: Splash screen module loaded.');
})();

// Module marker so this out-of-band IIFE can be re-imported by its vitest
// suite; type-only, erased by esbuild (iife) — no runtime effect.
export {};
