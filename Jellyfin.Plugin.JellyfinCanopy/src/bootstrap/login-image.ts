// src/bootstrap/login-image.ts
//
// Out-of-band loader: compiled to its own dist/login-image.js IIFE and served
// separately (js/plugin.js loads it pre-login, config-gated on EnableLoginImage).
// It is NOT part of jc.bundle.js — it runs on the login page before the user is
// authenticated and before the main bundle loads.
//
// Attaches JC.initializeLoginImage to the shared namespace. Behaviour is
// identical to the former js/extras/login-image.js; this is a typed port.

(function () {
    'use strict';

    // Cleanup handlers
    let nameInputListener: (() => void) | null = null;
    let formObserver: MutationObserver | null = null;
    let cardsObserver: MutationObserver | null = null;
    let updateTimeout: number | null = null;

    // Image cache to store preloaded images (FIFO-capped via cacheImage; this
    // IIFE cannot import core/bounded-cache).
    const IMAGE_CACHE_MAX = 100; // covers a login user grid
    const imageCache = new Map<string, HTMLImageElement>();

    /**
     * Inserts into imageCache with a FIFO size cap so the pre-login cache
     * cannot grow unbounded across form churn.
     */
    const cacheImage = (url: string, img: HTMLImageElement): void => {
        if (imageCache.size >= IMAGE_CACHE_MAX && !imageCache.has(url)) {
            const first = imageCache.keys().next().value;
            if (first !== undefined) imageCache.delete(first);
        }
        imageCache.set(url, img);
    };

    /**
     * Checks if a user is currently logged in by verifying the existence of the ApiClient
     * and the current user's session information.
     */
    const isUserLoggedIn = (): boolean => {
        try {
            const api = window.ApiClient as ({ _currentUser?: { Id?: string } } | undefined);
            const loggedIn = api && api._currentUser && api._currentUser.Id;
            return !!loggedIn;
        } catch (error) {
            console.error('🪼 Jellyfin Canopy: Login Image - Error checking login status.', error);
            return false;
        }
    };

    const getServerAddress = (): string => window.location.origin;
    const getUserImageUrl = (userId: string | null | undefined, quality = 40): string =>
        userId ? `${getServerAddress()}/Users/${userId}/Images/Primary?quality=${quality}` : '';

    /**
     * Preloads and caches an image URL.
     */
    const preloadImage = (url: string, username: string): Promise<HTMLImageElement> => {
        return new Promise((resolve, reject) => {
            // Check if already cached
            if (imageCache.has(url)) {
                resolve(imageCache.get(url)!);
                return;
            }

            const img = new Image();
            img.onload = () => {
                cacheImage(url, img);
                resolve(img);
            };
            img.onerror = () => {
                reject(new Error('Failed to load image'));
            };
            img.src = url;
        });
    };

    /**
     * Preloads all user images from the login page cards.
     */
    const preloadAllUserImages = (): void => {
        const userCardsContainer = document.getElementById('divUsers');
        if (!userCardsContainer) {
            return;
        }

        const userCards = userCardsContainer.querySelectorAll<HTMLElement>('.cardContent[data-username]');
        const preloadPromises: Promise<HTMLImageElement>[] = [];

        userCards.forEach((card) => {
            const username = card.dataset.username ?? '';
            const cardImageContainer = card.querySelector<HTMLElement>('.cardImageContainer');

            if (cardImageContainer && cardImageContainer.style.backgroundImage) {
                const style = cardImageContainer.style.backgroundImage;
                const urlMatch = style.match(/url\(['"]?(.*?)['"]?\)/);

                if (urlMatch && urlMatch[1]) {
                    const baseImageUrl = getBaseImageUrl(urlMatch[1]);
                    const highQualityUrl = cleanImageUrl(baseImageUrl, 90);

                    // Preload high quality image
                    preloadPromises.push(
                        preloadImage(highQualityUrl, username).catch(() => {
                            // Silently fail for individual images
                            return new Image();
                        })
                    );
                }
            }
        });

        if (preloadPromises.length > 0) {
            void Promise.all(preloadPromises);
        }
    };

    /**
     * Gets the label element for the username input.
     */
    const getUserLabel = (): HTMLElement | null => {
        const form = document.querySelector('.manualLoginForm');
        return form ? form.querySelector<HTMLElement>('label[for="txtManualName"]') : null;
    };

    /**
     * Resets the form state to show username input and hide profile image.
     */
    const resetFormState = (): void => {
        const userNameInput = document.getElementById('txtManualName');
        const userLabel = getUserLabel();
        const imgContainer = document.getElementById('userProfileImageContainer');

        if (userNameInput) userNameInput.style.display = '';
        if (userLabel) userLabel.style.display = '';
        if (imgContainer) imgContainer.remove();
    };

    /**
     * Cleans up an image URL by removing unnecessary parameters and setting quality.
     */
    const cleanImageUrl = (rawUrl: string, quality: number): string => {
        try {
            const url = new URL(rawUrl, window.location.origin);
            url.searchParams.delete('width');
            url.searchParams.delete('height');
            url.searchParams.delete('tag');
            url.searchParams.set('quality', quality.toString());
            return url.toString();
        } catch (e) {
            console.error('🪼 Jellyfin Canopy: Login Image - Invalid URL', e);
            return rawUrl;
        }
    };

    /**
     * Extracts the base URL without quality parameter from a full image URL.
     */
    const getBaseImageUrl = (fullUrl: string): string => {
        try {
            const url = new URL(fullUrl, window.location.origin);
            url.searchParams.delete('quality');
            return url.toString();
        } catch (e) {
            return fullUrl;
        }
    };

    /**
     * Creates and displays an image element with progressive loading.
     * Uses cached images if available for instant display.
     */
    const displayProgressiveImage = (
        baseImageUrl: string,
        currentUsername: string,
        imageContainer: HTMLElement,
        userNameInput: HTMLElement | null,
        userLabel: HTMLElement | null
    ): void => {

        const highQualityUrl = cleanImageUrl(baseImageUrl, 90);

        // Create the image element
        const imgElement = document.createElement('img');
        imgElement.alt = `Profile picture for ${currentUsername}`;
        imgElement.style.cssText = `
            width: clamp(120px, 18vw, 180px);
            height: clamp(120px, 18vw, 180px);
            object-fit: cover;
            display: block;
            margin: 0 auto 20px auto;
        `;

        // Check if high quality image is already cached
        if (imageCache.has(highQualityUrl)) {
            // Use cached image immediately
            imgElement.src = highQualityUrl;
            imageContainer.appendChild(imgElement);

            // Hide username input
            if (userNameInput) userNameInput.style.display = 'none';
            if (userLabel) userLabel.style.display = 'none';
            return;
        }

        // Cache miss - load image with fallback
        imgElement.style.opacity = '0';
        imgElement.style.transition = 'opacity 0.2s ease-in-out';

        let imageLoaded = false;

        // Handle errors
        imgElement.onerror = () => {
            console.warn('🪼 Jellyfin Canopy: Login Image - Failed to load image');
            resetFormState();
        };

        // When image loads
        imgElement.onload = () => {
            if (!imageLoaded) {
                imageLoaded = true;
                imgElement.style.opacity = '1';

                // Cache the image
                cacheImage(highQualityUrl, imgElement);
            }
        };

        // Load the high quality image directly
        imgElement.src = highQualityUrl;
        imageContainer.appendChild(imgElement);

        // Hide username input
        if (userNameInput) userNameInput.style.display = 'none';
        if (userLabel) userLabel.style.display = 'none';
    };

    /**
     * Finds the user's profile image and displays it above the password field.
     * It also hides the username input field, as the user is selected from a card.
     */
    const updateProfilePicture = (): void => {
        const userNameInput = document.getElementById('txtManualName') as HTMLInputElement | null;
        const manualLoginForm = document.querySelector('.manualLoginForm');
        const userLabel = getUserLabel();

        // Don't run if the form isn't ready or is hidden
        if (!userNameInput || !manualLoginForm || manualLoginForm.classList.contains('hide')) {
            resetFormState();
            return;
        }

        const currentUsername = userNameInput.value.trim();

        // If no username, reset and show input field
        if (!currentUsername) {
            resetFormState();
            return;
        }

        let userId: string | null = null;
        let baseImageUrl: string | null = null;

        // Try to get user ID and image URL from the user cards on the login page
        const userCardsContainer = document.getElementById('divUsers');
        if (userCardsContainer) {
            const userCardContent = userCardsContainer.querySelector<HTMLElement>(`.cardContent[data-username="${currentUsername}"]`);
            if (userCardContent) {
                userId = userCardContent.dataset.userid ?? null;

                const cardImageContainer = userCardContent.querySelector<HTMLElement>('.cardImageContainer');
                if (cardImageContainer && cardImageContainer.style.backgroundImage) {
                    const style = cardImageContainer.style.backgroundImage;
                    const urlMatch = style.match(/url\(['"]?(.*?)['"]?\)/);
                    if (urlMatch && urlMatch[1]) {
                        baseImageUrl = getBaseImageUrl(urlMatch[1]);
                    }
                }
            }
        }

        // If we got a user ID but no image from the card, construct the URL manually
        if (userId && !baseImageUrl) {
            baseImageUrl = getBaseImageUrl(getUserImageUrl(userId, 40));
        }

        // If no image URL was found, ensure the username input is visible
        if (!baseImageUrl) {
            resetFormState();
            return;
        }

        // Find or create the container for the profile image
        let imageContainer = document.getElementById('userProfileImageContainer');
        if (!imageContainer) {
            imageContainer = document.createElement('div');
            imageContainer.id = 'userProfileImageContainer';
            imageContainer.style.cssText = `
                text-align: center;
                margin-bottom: 20px;
                min-height: clamp(140px, 20vw, 200px);
            `;
            const inputContainer = manualLoginForm.querySelector('.inputContainer');
            if (inputContainer) {
                manualLoginForm.insertBefore(imageContainer, inputContainer);
            } else {
                manualLoginForm.prepend(imageContainer);
            }
        }

        imageContainer.innerHTML = '';

        // Display the image with progressive loading
        displayProgressiveImage(baseImageUrl, currentUsername, imageContainer, userNameInput, userLabel);
    };

    /**
     * Debounced version of updateProfilePicture to avoid excessive updates.
     */
    const debouncedUpdate = (): void => {
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(updateProfilePicture, 50);
    };

    /**
     * Cleans up event listeners and observers.
     */
    const cleanup = (): void => {
        const userNameInput = document.getElementById('txtManualName');

        if (nameInputListener && userNameInput) {
            userNameInput.removeEventListener('input', nameInputListener);
            nameInputListener = null;
        }

        if (formObserver) {
            formObserver.disconnect();
            formObserver = null;
        }

        if (cardsObserver) {
            cardsObserver.disconnect();
            cardsObserver = null;
        }

        if (updateTimeout) {
            clearTimeout(updateTimeout);
            updateTimeout = null;
        }

        imageCache.clear();
    };

    /**
     * Applies progressive loading to all user cards on the main login page.
     */
    const applyProgressiveLoadingToCards = (): void => {
        const userCardsContainer = document.getElementById('divUsers');
        if (!userCardsContainer) {
            return;
        }

        const cardImageContainers = userCardsContainer.querySelectorAll<HTMLElement>('.cardImageContainer');

        cardImageContainers.forEach((container, index) => {
            // Skip if already processed
            if (container.dataset.progressiveLoaded === 'true') {
                return;
            }
            container.dataset.progressiveLoaded = 'true';

            const bgImage = container.style.backgroundImage;
            if (!bgImage) return;

            const urlMatch = bgImage.match(/url\(['"]?(.*?)['"]?\)/);
            if (!urlMatch || !urlMatch[1]) return;

            const baseImageUrl = getBaseImageUrl(urlMatch[1]);
            const lowQualityUrl = cleanImageUrl(baseImageUrl, 5);
            const highQualityUrl = cleanImageUrl(baseImageUrl, 90);

            // Create a wrapper div for the blur effect so it doesn't interfere with hover transform
            const blurOverlay = document.createElement('div');
            blurOverlay.className = 'progressive-blur-overlay';
            blurOverlay.style.cssText = `
                position: absolute;
                inset: 0;
                background-image: url("${lowQualityUrl}");
                background-size: cover;
                background-position: center;
                filter: blur(8px);
                transition: opacity 0.3s ease-in-out;
                pointer-events: none;
                z-index: 1;
                overflow: hidden;
            `;

            // Ensure container is positioned and clips overflow
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            container.style.overflow = 'hidden'; // Clip the scaled blur overlay to circular bounds

            // Add blur overlay
            container.appendChild(blurOverlay);

            // Set high quality as background immediately (it will load in background)
            container.style.backgroundImage = `url("${highQualityUrl}")`;

            // Preload high quality
            const highQualityImg = new Image();
            highQualityImg.onload = () => {
                // Fade out the blur overlay
                blurOverlay.style.opacity = '0';
                setTimeout(() => {
                    if (blurOverlay.parentNode) {
                        blurOverlay.remove();
                    }
                }, 300);
            };
            highQualityImg.onerror = () => {
                console.warn(`🪼 Jellyfin Canopy: Login Image - Card ${index + 1} high quality failed, keeping low quality`);
                container.style.backgroundImage = `url("${lowQualityUrl}")`;
                if (blurOverlay.parentNode) {
                    blurOverlay.remove();
                }
            };
            highQualityImg.src = highQualityUrl;
        });
    };

    /**
     * Sets up event listeners and observers to watch for changes to the login form.
     */
    const setupObservers = (): void => {
        const userNameInput = document.getElementById('txtManualName');
        const manualLoginForm = document.querySelector('.manualLoginForm');

        if (!userNameInput || !manualLoginForm) {
            console.error('🪼 Jellyfin Canopy: Login Image - Required elements not found.');
            return;
        }

        // Listen for changes to the username input value (when a user card is clicked)
        nameInputListener = () => {
            debouncedUpdate();
        };
        userNameInput.addEventListener('input', nameInputListener);

        // Observe changes to the form's visibility (e.g., switching to passwordless login)
        formObserver = new MutationObserver(() => {
            if (!manualLoginForm.classList.contains('hide')) {
                debouncedUpdate();
            } else {
                resetFormState();
            }
        });
        formObserver.observe(manualLoginForm, { attributes: true, attributeFilter: ['class'] });

        // Trigger an initial update in case the form is already visible on load
        // This is KEY - it will check for pre-populated usernames
        if (!manualLoginForm.classList.contains('hide')) {
            // Use setTimeout to ensure DOM is fully ready
            setTimeout(() => {
                updateProfilePicture();
            }, 100);
        } else {
            resetFormState();
        }

        // Also apply progressive loading to the user cards on the main page
        applyProgressiveLoadingToCards();

        // Preload all user images for instant display when selected
        preloadAllUserImages();

        // Watch for new cards being added (in case the page dynamically loads users)
        const userCardsContainer = document.getElementById('divUsers');
        if (userCardsContainer) {
            // Store on the module ref so cleanup() disconnects it (it was a local
            // const before, never torn down); guard against stacking on re-entry.
            if (cardsObserver) cardsObserver.disconnect();
            cardsObserver = new MutationObserver(() => {
                applyProgressiveLoadingToCards();
                preloadAllUserImages();
            });
            cardsObserver.observe(userCardsContainer, { childList: true, subtree: true });
        }
    };

    // --- Initialization and Page Check Logic ---

    let attempts = 0;
    const maxAttempts = 200; // Try to find the login form for 20 seconds (200 * 100ms)

    /**
     * The main initialization function. It checks for the correct page context
     * before running the script's core logic.
     */
    const initializeLoginImage = (): void => {
        // Condition 1: If a user is already logged in, we are not on the login page. Stop the script.
        if (isUserLoggedIn()) {
            return;
        }

        // Condition 2: Check for the login form elements.
        const userNameInput = document.getElementById('txtManualName');
        const manualLoginForm = document.querySelector('.manualLoginForm');

        if (userNameInput && manualLoginForm) {
            // Elements found, so we are on the login page. Run the main script logic.
            console.log('🪼 Jellyfin Canopy: Login Image initialized');
            setupObservers();

            // Clean up when page unloads
            window.addEventListener('beforeunload', cleanup);
        } else {
            // Elements not found yet. Try again after a short delay.
            attempts++;
            if (attempts < maxAttempts) {
                setTimeout(initializeLoginImage, 100);
            }
        }
    };

    // Export functions to global namespace
    window.JellyfinCanopy.initializeLoginImage = initializeLoginImage;

    // Start the initialization process when the script loads.
    initializeLoginImage();
})();

// Module marker so this out-of-band IIFE can be re-imported by its vitest
// suite; type-only, erased by esbuild (iife) — no runtime effect.
export {};
