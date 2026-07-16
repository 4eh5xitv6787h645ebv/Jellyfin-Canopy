// src/seerr/modal.ts
import { JC } from '../globals';
import { installModalA11y, type ModalA11yHandle } from '../core/modal-a11y';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/** Options for the generic Seerr request modal. */
export interface SeerrModalOptions {
    title: string;
    subtitle: string;
    bodyHtml: string;
    backdropPath?: string | null;
    backdropUrl?: string | null;
    onSave: (modalElement: HTMLElement, primaryBtn: HTMLButtonElement, close: () => void) => void | Promise<void>;
    onClose?: () => void;
    buttonText?: string;
}

/** Handle returned by SeerrModalApi.create. */
export interface SeerrModalHandle {
    modalElement: HTMLElement;
    show: () => void;
    close: () => void;
}

/** Generic Seerr request modal factory (JC.seerrModal). */
export interface SeerrModalApi {
    create: (options: SeerrModalOptions) => SeerrModalHandle;
    createAdvancedOptionsHTML: (idPrefix: string) => string;
    populateAdvancedOptions: (modalElement: HTMLElement, data: any, idPrefix: string) => void;
    closeAll: () => void;
}

declare module '../types/jc' {
    interface JEGlobal {
        /** Generic Seerr request modal (src/seerr/modal.ts). */
        seerrModal?: SeerrModalApi;
    }
}

const logPrefix = '🪼 Jellyfin Canopy: Seerr Modal:';
const modal = {} as SeerrModalApi;
type ManagedModal = SeerrModalHandle & { destroy: () => void };
type IdentityCleanupElement = HTMLElement & { _jcIdentityCleanups?: Set<() => void> };
const activeModals = new Set<ManagedModal>();

const escapeHtml = JC.escapeHtml;

/**
 * Creates and manages a generic modal for Seerr requests.
 * @param {object} options - Configuration for the modal.
 * @param {string} options.title - The main title of the modal.
 * @param {string} options.subtitle - The subtitle (usually the movie/show name).
 * @param {string} options.bodyHtml - The HTML content for the modal body.
 * @param {string} options.backdropPath - TMDB backdrop image path (e.g., '/abc123.jpg').
 * @param {string} options.backdropUrl - Full backdrop image URL (alternative to backdropPath).
 * @param {function} options.onSave - The callback function to execute when the primary button is clicked.
 * @param {function} [options.onClose] - Optional cleanup callback invoked before the modal is removed.
 * @param {string} [options.buttonText] - Optional custom text for the primary button (defaults to localized 'Request').
 * @returns {object} - An object with methods to show and close the modal.
 */
modal.create = function({ title, subtitle, bodyHtml, backdropPath, backdropUrl, onSave, onClose, buttonText }) {
    const identity = JC.identity.capture();
    const modalElement = document.createElement('div') as IdentityCleanupElement;
    modalElement.className = 'seerr-season-modal';
    modalElement.dataset.jcIdentityOwned = 'true';
    JC.identity.own(modalElement, identity);
    modalElement.setAttribute('role', 'dialog');
    modalElement.setAttribute('aria-modal', 'true');
    modalElement.setAttribute('tabindex', '-1');

    // Support both backdropUrl (full URL) and backdropPath (TMDB path)
    let backdropImage;
    if (backdropUrl) {
        backdropImage = `url('${escapeHtml(backdropUrl)}')`;
    } else if (backdropPath) {
        backdropImage = `url('https://image.tmdb.org/t/p/w1280${escapeHtml(backdropPath)}')`;
    } else {
        backdropImage = 'linear-gradient(45deg, #3b82f6, #8b5cf6)';
    }

    // Build modal structure — bodyHtml is intentionally trusted HTML from internal callers
    const contentEl = document.createElement('div');
    contentEl.className = 'seerr-season-content';
    contentEl.setAttribute('role', 'document');
    contentEl.setAttribute('aria-labelledby', 'seerr-modal-title');

    const headerEl = document.createElement('div');
    headerEl.className = 'seerr-season-header';
    headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;

    const titleEl = document.createElement('div');
    titleEl.id = 'seerr-modal-title';
    titleEl.className = 'seerr-season-title';
    titleEl.textContent = title;

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'seerr-season-subtitle';
    subtitleEl.textContent = subtitle;

    headerEl.appendChild(titleEl);
    headerEl.appendChild(subtitleEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'seerr-modal-body';
    bodyEl.style.cssText = 'padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;';
    bodyEl.innerHTML = bodyHtml;

    const footerEl = document.createElement('div');
    footerEl.className = 'seerr-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'seerr-modal-button seerr-modal-button-secondary';
    cancelBtn.setAttribute('aria-label', JC.t!('seerr_modal_cancel'));
    cancelBtn.textContent = JC.t!('seerr_modal_cancel');

    const primaryBtn = document.createElement('button');
    primaryBtn.className = 'seerr-modal-button seerr-modal-button-primary';
    primaryBtn.setAttribute('aria-label', buttonText || JC.t!('seerr_modal_request'));
    primaryBtn.textContent = buttonText || JC.t!('seerr_modal_request');

    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(primaryBtn);

    contentEl.appendChild(headerEl);
    contentEl.appendChild(bodyEl);
    contentEl.appendChild(footerEl);

    modalElement.appendChild(contentEl);

    // A11Y-5: focus trap + Escape + focus RESTORE come from the shared modal
    // util (the former hand-rolled handleKeydown trapped focus but never
    // restored it, and never counted toward the jc-modal-open shortcut gate).
    let a11y: ModalA11yHandle | null = null;

    let isClosing = false;
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanups = new Set<() => void>();
    modalElement._jcIdentityCleanups = cleanups;
    const isCurrent = () => !!identity && JC.identity.isCurrent(identity) && !isClosing;

    const show = () => {
        if (!isCurrent() || document.body.contains(modalElement)) return;
        document.body.appendChild(modalElement);
        document.body.classList.add('seerr-modal-is-open');
        // Add a state to history to handle back button for closing
        history.pushState(null, '', location.href);
        window.addEventListener('popstate', close);
        a11y = installModalA11y(modalElement, {
            labelledBy: 'seerr-modal-title',
            initialFocus: () => modalElement.querySelector<HTMLElement>('button:not([disabled]), select, input'),
            onEscape: () => history.back(), // keep the history-based close mechanism
        });
        showTimer = setTimeout(() => {
            showTimer = null;
            if (isCurrent() && document.body.contains(modalElement)) modalElement.classList.add('show');
        }, 10);
    };

    const finishClose = () => {
        if (document.body.contains(modalElement)) modalElement.remove();
        activeModals.delete(handle);
        if (activeModals.size === 0) document.body.classList.remove('seerr-modal-is-open');
    };

    const closeInternal = (immediate: boolean) => {
        if (isClosing) return;
        isClosing = true;

        if (showTimer !== null) {
            clearTimeout(showTimer);
            showTimer = null;
        }
        if (removeTimer !== null) {
            clearTimeout(removeTimer);
            removeTimer = null;
        }
        for (const cleanup of cleanups) {
            try { cleanup(); } catch { /* continue closing */ }
        }
        cleanups.clear();

        if (typeof onClose === 'function') {
            try {
                onClose();
            } catch (err) {
                console.error(`${logPrefix} onClose handler failed:`, err);
            }
        }

        window.removeEventListener('popstate', close);
        a11y?.release(); // restores focus to the trigger + lifts the shortcut gate
        a11y = null;
        modalElement.classList.remove('show');
        if (immediate) {
            finishClose();
        } else {
            removeTimer = setTimeout(() => {
                removeTimer = null;
                finishClose();
            }, 300);
        }
    };
    const close = () => closeInternal(false);

    // Event listeners for closing the modal
    cancelBtn.addEventListener('click', () => { if (isCurrent()) history.back(); });
    modalElement.addEventListener('click', (e: MouseEvent) => { if (isCurrent() && e.target === modalElement) history.back(); });

    // Event listener for the primary action button
    primaryBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        void onSave(modalElement, primaryBtn, close);
    });

    const handle: ManagedModal = { modalElement, show, close, destroy: () => closeInternal(true) };
    activeModals.add(handle);
    return handle;
};

/**
 * Generates the HTML string for the advanced request options form.
 * @param {string} idPrefix - A prefix ('movie' or 'tv') to ensure unique element IDs.
 * @returns {string} - The HTML content for the form.
 */
modal.createAdvancedOptionsHTML = function(idPrefix) {
    return `
        <div class="seerr-advanced-options">
            <h3>${JC.t!('seerr_advanced_options')}</h3>
            <div class="seerr-form-row">
                <div class="seerr-form-group">
                    <label for="${idPrefix}-server">${JC.t!('seerr_server_select')}</label>
                    <select is="emby-select" id="${idPrefix}-server" class="emby-select"></select>
                </div>
                <div class="seerr-form-group">
                    <label for="${idPrefix}-quality">${JC.t!('seerr_quality_select')}</label>
                    <select is="emby-select" id="${idPrefix}-quality" class="emby-select"></select>
                </div>
            </div>
            <div class="seerr-form-row">
                <div class="seerr-form-group">
                    <label for="${idPrefix}-folder">${JC.t!('seerr_folder_select')}</label>
                    <select is="emby-select" id="${idPrefix}-folder" class="emby-select"></select>
                </div>
            </div>
        </div>
    `;
};

/**
 * Populates the select dropdowns in the advanced options form.
 * @param {HTMLElement} modalElement - The root element of the modal.
 * @param {object} data - The data fetched from the API, containing servers, profiles, and folders.
 * @param {string} idPrefix - The prefix ('movie' or 'tv') used for the element IDs.
 */
modal.populateAdvancedOptions = function(modalElement, data, idPrefix) {
    const identity = JC.identity.ownerOf(modalElement) || JC.identity.capture();
    const isCurrent = () => !!identity
        && JC.identity.isCurrent(identity)
        && document.body.contains(modalElement);
    // Backend failed to load server options: show an error note instead of
    // polling for selects that will only ever be populated with empty
    // placeholders — three empty dropdowns look like a valid config (W4-ERR-5).
    if (data && data.error) {
        const container = modalElement.querySelector('.seerr-advanced-options');
        if (container) {
            container.innerHTML = `<h3>${JC.t!('seerr_advanced_options')}</h3><div class="seerr-advanced-error">${JC.escapeHtml(data.error)}</div>`;
        }
        return;
    }

    // Use a timer to ensure emby-select elements are ready
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds
    const interval = setInterval(() => {
        if (!isCurrent()) {
            clearInterval(interval);
            return;
        }
        const serverSelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-server`);
        const qualitySelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-quality`);
        const folderSelect = modalElement.querySelector<HTMLSelectElement>(`#${idPrefix}-folder`);

        if (serverSelect && qualitySelect && folderSelect) {
            clearInterval(interval);

            serverSelect.innerHTML = '<option value="">Select Server...</option>';
            qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
            folderSelect.innerHTML = '<option value="">Select Folder...</option>';

            data.servers.forEach((server: any) => {
                const option = document.createElement('option');
                option.value = server.id;
                option.textContent = server.name || `Server ${server.id}`;
                if (server.isDefault) option.selected = true;
                serverSelect.appendChild(option);
            });

            function updateServerDependentOptions() {
                const selectedServer = data.servers.find((s: any) => s.id == serverSelect!.value);
                qualitySelect!.innerHTML = '<option value="">Select Quality...</option>';
                folderSelect!.innerHTML = '<option value="">Select Folder...</option>';
                if (!selectedServer) return;

                selectedServer.qualityProfiles.forEach((profile: any) => {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = profile.name || `Profile ${profile.id}`;
                    if (profile.id === selectedServer.activeProfileId) option.selected = true;
                    qualitySelect!.appendChild(option);
                });
                selectedServer.rootFolders.forEach((folder: any) => {
                    const option = document.createElement('option');
                    option.value = folder.path;
                    option.textContent = folder.path;
                    if (folder.path === selectedServer.activeDirectory) option.selected = true;
                    folderSelect!.appendChild(option);
                });
            }

            serverSelect.addEventListener('change', updateServerDependentOptions);
            // Trigger initial population if a default server is selected
            if (serverSelect.value) {
                updateServerDependentOptions();
            }

        } else {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                console.error(`${logPrefix} Could not find advanced options elements in modal after ${maxAttempts} attempts.`);
            }
        }
    }, 100);
    const cleanups = (modalElement as IdentityCleanupElement)._jcIdentityCleanups;
    cleanups?.add(() => clearInterval(interval));
};

modal.closeAll = function(): void {
    for (const active of [...activeModals]) active.destroy();
};

let uninstallIdentityReset: (() => void) | null = null;
let configListenerInstalled = false;

export function installSeerrModal(): () => void {
    JC.seerrModal = modal;
    uninstallIdentityReset ??= JC.identity.registerReset('seerr-request-modal', modal.closeAll);
    // Advanced modals snapshot the 4K gate. Retire them at config boundaries.
    if (!configListenerInstalled) {
        window.addEventListener('jc:config-changed', modal.closeAll);
        configListenerInstalled = true;
    }
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        uninstallIdentityReset?.();
        uninstallIdentityReset = null;
        if (configListenerInstalled) {
            window.removeEventListener('jc:config-changed', modal.closeAll);
            configListenerInstalled = false;
        }
        modal.closeAll();
    };
}


installSeerrModal();
