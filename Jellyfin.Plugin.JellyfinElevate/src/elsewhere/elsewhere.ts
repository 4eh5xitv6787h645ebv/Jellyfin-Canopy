// src/elsewhere/elsewhere.ts
/**
 * @file Manages the "Jellyfin Elsewhere" feature to find streaming providers.
 */

import { JE as JEBase } from '../globals';
import { assetUrl } from '../core/asset-urls';
import { isDetailsPageVisible } from '../core/details-view';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate, onViewPage } from '../core/navigation';
import type { ApiApi, JELegacyHelpers, PluginConfig } from '../types/je';

/** Options accepted by helpers.createExternalLink (and its local fallback). */
interface ExternalLinkOptions {
    text?: string;
    title?: string;
    className?: string;
}

/**
 * Local view of the shared namespace adding the public member this module
 * OWNS plus the legacy helper/config/user-settings members it reads that are
 * not yet typed on JEGlobal (owned by unconverted js/ modules).
 */
const JE = JEBase as typeof JEBase & {
    initializeElsewhereScript?: () => void;
    t: (key: string, params?: Record<string, unknown>) => string;
    saveUserSettings: (fileName: string, data: unknown) => void;
    userConfig: Record<string, any>;
    core: { api: ApiApi };
    pluginConfig: PluginConfig & {
        ElsewhereEnabled?: boolean;
        TmdbEnabled?: boolean;
        DEFAULT_REGION?: string;
        DEFAULT_PROVIDERS?: string;
        IGNORE_PROVIDERS?: string;
        ElsewhereCustomBrandingText?: string;
        ElsewhereCustomBrandingImageUrl?: string;
    };
    helpers: JELegacyHelpers & {
        createExternalLink?: (url: string, options?: ExternalLinkOptions) => HTMLAnchorElement;
        debounce?: <T extends (...args: any[]) => void>(fn: T, wait: number) => T;
    };
};

/**
 * Initializes the Jellyfin Elsewhere script.
 * It will only run if the server reports TMDB is configured.
 */
JE.initializeElsewhereScript = function() {
    if (!JE.pluginConfig.ElsewhereEnabled) {
        console.log('🪼 Jellyfin Elevate: 🎬 Jellyfin Elsewhere: Feature is disabled in plugin settings.');
        return;
    }
    // --- Configuration ---
    const TmdbEnabled = !!JE.pluginConfig.TmdbEnabled;
    const DEFAULT_REGION = JE.pluginConfig.DEFAULT_REGION || 'US';
    const DEFAULT_PROVIDERS = JE.pluginConfig.DEFAULT_PROVIDERS ? JE.pluginConfig.DEFAULT_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
    const IGNORE_PROVIDERS = JE.pluginConfig.IGNORE_PROVIDERS ? JE.pluginConfig.IGNORE_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
    const ELSEWHERE_CUSTOM_BRANDING_TEXT = JE.pluginConfig.ElsewhereCustomBrandingText || '';
    const ELSEWHERE_CUSTOM_BRANDING_IMAGE_URL = JE.pluginConfig.ElsewhereCustomBrandingImageUrl || '';

    if (!TmdbEnabled) {
        console.log('🪼 Jellyfin Elevate: 🎬 Jellyfin Elsewhere: TMDB is not configured, skipping initialization');
        return;
    }

    let userRegion = DEFAULT_REGION;
    let userRegions: string[] = []; // Multiple regions for search
    let userServices: string[] = []; // Empty by default - will show all services from settings region
    let availableRegions: Record<string, string> = {};
    let availableProviders: string[] = [];

    // Safe fallback for helpers.js Stage-3 load-order races.
    const extLink = JE.helpers?.createExternalLink || ((u: string, o?: ExternalLinkOptions) => {
        const a = document.createElement('a');
        a.setAttribute('is', 'emby-linkbutton');
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (o?.text) a.textContent = o.text;
        if (o?.title) a.title = o.title;
        if (o?.className) a.className = o.className;
        return a;
    });

    console.log('🪼 Jellyfin Elevate: 🎬 Jellyfin Elsewhere starting...');

    // Load regions and providers (mirrored from the Jellyfin-Elsewhere repo).
    // PERF(R6): no remote assets — both .txt files are served from the local asset cache.
    function loadRegionsAndProviders(): void {
        fetch(assetUrl('elsewhere/regions.txt'))
            .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(text => {
                const lines = text.trim().split('\n');
                lines.forEach(line => {
                    if (line.startsWith('#')) return;
                    const [code, name] = line.split('\t');
                    if (code && name) {
                        availableRegions[code] = name;
                    }
                });
            })
            .catch(() => {
                // Fallback to hardcoded regions
                availableRegions = {
                    'US': 'United States', 'GB': 'United Kingdom', 'IN': 'India', 'CA': 'Canada',
                    'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'AU': 'Australia',
                    'BR': 'Brazil', 'MX': 'Mexico', 'IE': 'Ireland', 'IT': 'Italy',
                    'ES': 'Spain', 'NL': 'Netherlands', 'SE': 'Sweden', 'NO': 'Norway',
                    'DK': 'Denmark', 'FI': 'Finland'
                };
            });

             // Load providers
        fetch(assetUrl('elsewhere/providers.txt'))
            .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(text => {
                availableProviders = text.trim().split('\n')
                    .filter(line => !line.startsWith('#') && line.trim() !== '');
            })
            .catch(() => {
                availableProviders = [
                    // Fallback to hardcoded providers
                    'Netflix', 'Amazon Prime Video', 'Disney Plus', 'HBO Max',
                    'Hulu', 'Apple TV Plus', 'Paramount Plus', 'Peacock',
                    'JioCinema', 'Disney+ Hotstar', 'ZEE5', 'SonyLIV'
                ];
            });
    }

    function createMaterialIcon(iconName: string, size = '18px'): HTMLElement {
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.textContent = iconName;
        icon.style.fontSize = size;
        icon.style.lineHeight = '1';
        return icon;
    }

    function createAutocompleteInput(placeholder: string, options: string[], selectedValues: string[], onSelect: (selected: string[]) => void): HTMLElement {
        const container = document.createElement('div');
        container.style.cssText = 'position: relative; margin-bottom: 6px;';

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        // Use helpers.debounce if available for consistent behavior
        const debouncedFilter = JE.helpers?.debounce ? JE.helpers.debounce((filterText: string) => {
            const value = filterText.toLowerCase();
            if (value.length === 0) {
                dropdown.style.display = 'none';
                return;
            }
            const filtered = options.filter(option =>
                option.toLowerCase().includes(value) && !selectedValues.includes(option)
            );
            showDropdown(filtered);
        }, 300) : null;

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder;
        input.style.cssText = `
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            box-sizing: border-box;
            background: #2a2a2a;
            color: #fff;
            font-size: 14px;
        `;

        const dropdown = document.createElement('div');
        dropdown.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #1a1a1a;
            border: 1px solid #444;
            border-top: none;
            border-radius: 6px;
            max-height: 200px;
            overflow-y: auto;
            display: none;
            z-index: 1000;
        `;

        const selectedContainer = document.createElement('div');
        selectedContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 6px;
        `;

        let selectedIndex = -1;
        let filteredOptions: string[] = [];

        function updateSelected(): void {
            selectedContainer.innerHTML = '';
            selectedValues.forEach(value => {
                const tag = document.createElement('span');
                tag.className = 'selected-tag';
                tag.style.cssText = `
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `;
                tag.textContent = value;

                const remove = document.createElement('span');
                remove.textContent = '×';
                remove.style.cssText = 'cursor: pointer; font-weight: bold; font-size: 14px;';
                remove.onclick = () => {
                    const index = selectedValues.indexOf(value);
                    if (index > -1) {
                        selectedValues.splice(index, 1);
                        updateSelected();
                    }
                };
                tag.appendChild(remove);
                selectedContainer.appendChild(tag);
            });
        }

        function showDropdown(options: string[]): void {
            dropdown.innerHTML = '';
            dropdown.style.display = 'block';
            filteredOptions = options;
            selectedIndex = -1;

            options.forEach((option, index) => {
                const item = document.createElement('div');
                item.textContent = option;
                item.style.cssText = `
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `;
                item.dataset.index = String(index);

                item.onmouseenter = () => {
                    clearSelection();
                    item.style.background = '#333';
                    selectedIndex = index;
                };

                item.onmouseleave = () => {
                    item.style.background = '#1a1a1a';
                };

                item.onclick = () => selectOption(option);
                dropdown.appendChild(item);
            });
        }

        function clearSelection(): void {
            dropdown.querySelectorAll('div').forEach(item => {
                item.style.background = '#1a1a1a';
            });
        }

        function updateSelection(): void {
            clearSelection();
            if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                const item = dropdown.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
                if (item) {
                    item.style.background = '#333';
                    item.scrollIntoView({ block: 'nearest' });
                }
            }
        }

        function selectOption(option: string): void {
            if (!selectedValues.includes(option)) {
                selectedValues.push(option);
                updateSelected();
                onSelect(selectedValues);
            }
            input.value = '';
            dropdown.style.display = 'none';
            selectedIndex = -1;
        }

        input.oninput = () => {
            if (debouncedFilter) {
                debouncedFilter(input.value);
            } else {
                // Fallback to manual debounce if helpers not available
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const value = input.value.toLowerCase();
                    if (value.length === 0) {
                        dropdown.style.display = 'none';
                        return;
                    }
                    const filtered = options.filter(option =>
                        option.toLowerCase().includes(value) && !selectedValues.includes(option)
                    );
                    showDropdown(filtered);
                }, 300);
            }
        };

        input.onkeydown = (e) => {
            if (dropdown.style.display === 'none') return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
                    updateSelection();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    selectedIndex = Math.max(selectedIndex - 1, -1);
                    updateSelection();
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                        selectOption(filteredOptions[selectedIndex]);
                    }
                    break;
                case 'Escape':
                    dropdown.style.display = 'none';
                    selectedIndex = -1;
                    break;
            }
        };

        input.onblur = () => {
            // Delay hiding to allow clicks on dropdown items
            setTimeout(() => {
                if (!dropdown.contains(document.activeElement)) {
                    dropdown.style.display = 'none';
                }
            }, 200);
        };

        container.appendChild(input);
        container.appendChild(dropdown);
        container.appendChild(selectedContainer);

        updateSelected();
        return container;
    }
    // Create settings modal
    function createSettingsModal(): void {
        const modal = document.createElement('div');
        modal.id = 'streaming-settings-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.85);
            display: none;
            z-index: 10000;
            align-items: center;
            justify-content: center;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: #181818;
            padding: 20px;
            border-radius: 8px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            color: #fff;
            border: 1px solid #333;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        `;

        content.innerHTML = `
            <h3 style="margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;">${JE.t('elsewhere_settings_title')}</h3>

            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_country')}</label>
                <select id="region-select" style="width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;">
                    ${Object.entries(availableRegions).map(([code, name]) =>
                        `<option value="${JE.escapeHtml(code)}" ${code === userRegion ? 'selected' : ''}>${JE.escapeHtml(name)}</option>`
                    ).join('')}
                </select>
            </div>

            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_other_countries')}</label>
                <div id="regions-autocomplete"></div>
            </div>

           <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_providers')}</label>
                <div id="services-autocomplete"></div>
            </div>

            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="cancel-settings" style="padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;">${JE.t('elsewhere_settings_cancel')}</button>
                <button id="save-settings" style="padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;">${JE.t('elsewhere_settings_save')}</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        // Add autocomplete for regions
        const regionsContainer = content.querySelector<HTMLElement>('#regions-autocomplete')!;
        const regionOptions = Object.entries(availableRegions).map(([code, name]) => `${name} (${code})`);
        const regionsAutocomplete = createAutocompleteInput(
            JE.t('elsewhere_settings_add_countries_placeholder'),
            regionOptions,
            userRegions.map(code => `${availableRegions[code] || code} (${code})`),
            () => {}
        );
        regionsContainer.appendChild(regionsAutocomplete);

        // Add autocomplete for services
        const servicesContainer = content.querySelector<HTMLElement>('#services-autocomplete')!;
        const servicesAutocomplete = createAutocompleteInput(
            JE.t('elsewhere_settings_add_providers_placeholder'),
            availableProviders,
            userServices.slice(),
            () => {}
        );
        servicesContainer.appendChild(servicesAutocomplete);

        document.getElementById('cancel-settings')!.onclick = () => {
            modal.style.display = 'none';
        };

        document.getElementById('save-settings')!.onclick = () => {
            userRegion = (document.getElementById('region-select') as HTMLSelectElement).value;

            // Get selected regions from autocomplete
            const selectedRegions: string[] = [];
            regionsContainer.querySelectorAll('.selected-tag').forEach(tag => {
                const text = tag.textContent.replace('×', '').trim();
                const match = text.match(/\(([A-Z]{2})\)$/);
                if (match) {
                    selectedRegions.push(match[1]);
                }
            });
            userRegions = selectedRegions;

            // Get selected services from autocomplete
            const selectedServices: string[] = [];
            servicesContainer.querySelectorAll('.selected-tag').forEach(tag => {
                selectedServices.push(tag.textContent.replace('×', '').trim());
            });
            userServices = selectedServices;

            modal.style.display = 'none';

            const elsewhereSettings = {
                Region: userRegion,
                Regions: userRegions,
                Services: userServices
            };
            void JE.saveUserSettings('elsewhere.json', elsewhereSettings);
        };

        // Close on backdrop click
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };
    }

    // Load saved settings
    function loadSettings(): void {
        const settings = JE.userConfig.elsewhere;
        userRegion = settings.Region || DEFAULT_REGION;
        userRegions = settings.Regions || [];
        userServices = settings.Services || [];
    }

    function createServiceBadge(service: any, tmdbId: string, mediaType: string): HTMLElement {
        const badge = document.createElement('div');
        badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            padding: 6px 10px;
            margin: 3px 5px 3px 0;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            color: #fff;
            white-space: nowrap;
            transition: all 500ms ease;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(10px);
        `;

        const logo = document.createElement('img');
        logo.src = `https://image.tmdb.org/t/p/w92${service.logo_path}`;
        logo.alt = service.provider_name;
        logo.style.cssText = `
            width: 20px;
            height: 20px;
            margin-right: 8px;
            object-fit: contain;
            border-radius: 4px;
        `;

        logo.onerror = () => logo.style.display = 'none';
        badge.appendChild(logo);

        const text = document.createElement('span');
        text.textContent = service.provider_name;
        badge.appendChild(text);

        // Hover effects
        badge.onmouseenter = () => {
            badge.style.transform = 'translateY(-2px)';
            badge.style.background = 'rgba(255, 255, 255, 0.2)';
            badge.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        };

        badge.onmouseleave = () => {
            badge.style.transform = 'translateY(0)';
            badge.style.background = 'rgba(255, 255, 255, 0.1)';
            badge.style.boxShadow = 'none';
        };

        return badge;
    }

    // Fetch streaming data
    function fetchStreamingData(tmdbId: string, mediaType: string, callback: (error: string | null, data?: any) => void): void {
        const url = ApiClient.getUrl(`/JellyfinElevate/tmdb/${mediaType}/${tmdbId}/watch/providers`);
        JE.core.api.fetch(url)
            .then(data => callback(null, data))
            .catch((error: unknown) => {
                let errorMessage;
                const errorMessageText = (error as Error).message || '';

                // Check 1: Network error (browser couldn't connect)
                if (error instanceof TypeError && errorMessageText === 'Failed to fetch') {
                    errorMessage = 'TMDB API is unreachable.';

                // Check 2: JSON parse error — server returned non-JSON with a 200 status
                // (e.g. a reverse proxy error page, or a Jellyfin middleware intercept)
                } else if (error instanceof SyntaxError) {
                    errorMessage = 'Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.';

                // Check 3: Invalid API Key error
                } else if (errorMessageText.includes('401')) {
                    errorMessage = 'Invalid TMDB API Key.';

                // Check 4: Item not found
                } else if (errorMessageText.includes('404')) {
                    errorMessage = 'The requested item could not be found on TMDB.';

                // Check 5: Rate limit error
                } else if (errorMessageText.includes('429')) {
                    errorMessage = 'Too many requests. Please wait a moment and try again.';

                // Check 6: TMDB server-side issues (e.g., 500, 502, 503, 504) —
                // JE.core.api throws Error('HTTP <status>') for non-OK responses
                } else if (errorMessageText.startsWith('HTTP 5')) {
                    errorMessage = 'The TMDB service is temporarily unavailable. Please try again later.';

                // Fallback: All other errors
                } else {
                    errorMessage = errorMessageText || 'An unknown error occurred';
                }

                callback(errorMessage);
            });
    }

    // Process streaming data for default region (auto-load)
    function processDefaultRegionData(data: any, tmdbId: string, mediaType: string): HTMLElement {
        const regionData = data.results[DEFAULT_REGION];

        const container = document.createElement('div');
        container.style.cssText = `
            margin: 10px 0;
            padding: 12px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            position: relative;
        `;

        // Create header with title and controls
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        `;


        // Check if services are available in default region
        const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

        // Pre-filter services to check if any will actually be displayed
        let filteredServices: any[] = [];
        if (hasServices) {
            filteredServices = regionData.flatrate;

            // Apply DEFAULT_PROVIDERS filter
            if (DEFAULT_PROVIDERS.length > 0) {
                filteredServices = filteredServices.filter((service: any) =>
                    DEFAULT_PROVIDERS.includes(service.provider_name)
                );
            }

            // Apply IGNORE_PROVIDERS filter
            if (IGNORE_PROVIDERS.length > 0) {
                try {
                    const ignorePatterns = IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'));
                    filteredServices = filteredServices.filter((service: any) =>
                        !ignorePatterns.some(regex => regex.test(service.provider_name))
                    );
                } catch (e) {
                    console.error('🪼 Jellyfin Elevate: 🎬 Jellyfin Elsewhere: Invalid regex in IGNORE_PROVIDERS.', e);
                }
            }
        }

        const hasFilteredServices = filteredServices.length > 0;

        // Create clickable title that links to JustWatch
        const title = extLink(
            (hasFilteredServices && regionData && regionData.link) ? regionData.link : '#',
            { title: 'JustWatch' }
        );

        if (hasFilteredServices) {
            title.textContent = JE.t('elsewhere_panel_available_in', { region: availableRegions[DEFAULT_REGION] || DEFAULT_REGION });
        } else if (ELSEWHERE_CUSTOM_BRANDING_TEXT) {
            // Show custom branding when no services are available and custom text is configured
            title.textContent = ELSEWHERE_CUSTOM_BRANDING_TEXT;
            title.classList.add('elsewhere-custom-branding');
            title.style.cursor = 'default';

            // Add custom icon if URL is provided
            if (ELSEWHERE_CUSTOM_BRANDING_IMAGE_URL) {
                title.style.display = 'flex';
                title.style.alignItems = 'center';
                title.style.gap = '8px';

                const icon = document.createElement('img');
                // PERF(R6, accepted admin exception): ELSEWHERE_CUSTOM_BRANDING_IMAGE_URL
                // is an admin-configured ARBITRARY URL, so it cannot be mirrored through
                // the local asset cache (a fixed manifest of known keys — see
                // core/asset-urls.ts). Like the login-image/splash admin-URL exception,
                // it is served from the admin's chosen host directly. This is a DOM `.src`
                // assignment (no HTML sink), so there is no XSS surface; onerror hides it
                // if the host is unreachable.
                icon.src = ELSEWHERE_CUSTOM_BRANDING_IMAGE_URL;
                icon.alt = 'Custom Branding';
                icon.className = 'elsewhere-custom-branding-icon';
                icon.style.cssText = `
                    width: 24px;
                    height: 24px;
                    object-fit: contain;
                    margin-left: 4px;
                `;
                icon.onerror = () => icon.style.display = 'none';
                title.appendChild(icon);
            }
        } else {
            // Fallback to default message if no custom text is set
            title.textContent = JE.t('elsewhere_panel_not_available_in', { region: availableRegions[DEFAULT_REGION] || DEFAULT_REGION });
        }

        title.style.cssText = `
            font-weight: 600;
            font-size: 14px;
            text-decoration: none;
            cursor: pointer;
            color: #fff;
            flex: 1;
            text-align: left;
            display: flex;
            align-items: flex-end;
        `;

        // Add JustWatch link if available and has filtered services
        if (hasFilteredServices && regionData && regionData.link) {
            title.classList.add('elsewhere-link-reset');
            title.href = regionData.link;
            title.style.padding = '0';
            title.style.margin = '0';
        } else if (!hasFilteredServices && ELSEWHERE_CUSTOM_BRANDING_TEXT) {
            // Override cursor style for custom branded content
            title.style.cursor = 'default';
        }

         // Create controls container
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
        `;

        // Search button with Material Icon
        const searchButton = document.createElement('button');
        searchButton.className = 'elsewhere-search-button';
        const searchIcon = createMaterialIcon('search', '16px');
        searchButton.appendChild(searchIcon);
        searchButton.appendChild(document.createTextNode(''));

        searchButton.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 500ms ease;
            opacity: ${!hasFilteredServices && ELSEWHERE_CUSTOM_BRANDING_TEXT ? '0' : '1'};
        `;

        searchButton.onmouseenter = () => {
            searchButton.style.background = 'rgba(255, 255, 255, 0.2)';
        };

        searchButton.onmouseleave = () => {
            searchButton.style.background = 'rgba(255, 255, 255, 0.1)';
        };

        // Settings button with Material Icon
        const settingsButton = document.createElement('button');
        settingsButton.className = 'elsewhere-settings-button';
        const settingsIcon = createMaterialIcon('settings', '16px');
        settingsButton.appendChild(settingsIcon);

        settingsButton.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 500ms ease;
            width: 28px;
            height: 28px;
            opacity: ${!hasFilteredServices && ELSEWHERE_CUSTOM_BRANDING_TEXT ? '0' : '1'};
        `;

        settingsButton.onmouseenter = () => {
            settingsButton.style.background = 'rgba(255, 255, 255, 0.2)';
        };

        settingsButton.onmouseleave = () => {
            settingsButton.style.background = 'rgba(255, 255, 255, 0.1)';
        };

        settingsButton.onclick = () => {
            const modal = document.getElementById('streaming-settings-modal');
            if (modal) {
                modal.style.display = 'flex';
            }
        };

        controls.appendChild(searchButton);
        controls.appendChild(settingsButton);
        header.appendChild(title);
        header.appendChild(controls);
        container.appendChild(header);

        // Add hover effect to show/hide buttons when custom branding is enabled
        if (!hasFilteredServices && ELSEWHERE_CUSTOM_BRANDING_TEXT) {
            container.onmouseenter = () => {
                searchButton.style.opacity = '1';
                settingsButton.style.opacity = '1';
            };
            container.onmouseleave = () => {
                searchButton.style.opacity = '0';
                settingsButton.style.opacity = '0';
            };
        }

        // Show services if they exist after filtering, otherwise show appropriate message
        if (hasServices) {
            if (hasFilteredServices) {
                // Use the pre-filtered services
                const servicesContainer = document.createElement('div');
                servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;';

                filteredServices.forEach((service: any) => {
                    servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
                });

                container.appendChild(servicesContainer);
            } else if (DEFAULT_PROVIDERS.length > 0) {
                // Services exist but all were filtered out by user's provider preferences
                const noServices = document.createElement('div');
                noServices.textContent = JE.t('elsewhere_panel_no_configured_services');
                noServices.style.cssText = 'color: #999; font-size: 13px; margin-bottom: 12px;';
                container.appendChild(noServices);
            }
        }

        // Create manual result container for search results
        const resultContainer = document.createElement('div');
        resultContainer.id = 'streaming-result-container';
        container.appendChild(resultContainer);

        // Add click handler for manual lookup (multiple regions)
        searchButton.onclick = () => {
            searchButton.disabled = true;
            searchButton.innerHTML = '';
            const loadingIcon = createMaterialIcon('refresh', '16px');
            loadingIcon.style.animation = 'spin 1s linear infinite';
            searchButton.appendChild(loadingIcon);
            searchButton.appendChild(document.createTextNode(' ' + JE.t('elsewhere_panel_search_button')));
            searchButton.style.opacity = '0.7';
            resultContainer.innerHTML = '';

            // Add spinning animation
            const style = document.createElement('style');
            style.textContent = `
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `;
            if (!document.querySelector('style[data-jellyfin-elsewhere]')) {
                style.setAttribute('data-jellyfin-elsewhere', 'true');
                document.head.appendChild(style);
            }

            fetchStreamingData(tmdbId, mediaType, (error, data) => {
                searchButton.disabled = false;
                searchButton.innerHTML = '';
                const searchIcon = createMaterialIcon('search', '16px');
                searchButton.appendChild(searchIcon);
                searchButton.appendChild(document.createTextNode(''));
                searchButton.style.opacity = '1';

                if (error) {
                    resultContainer.innerHTML = `<div style="color: #ff6b6b; font-size: 13px; margin-top: 8px;">${JE.t('elsewhere_panel_error', { error: JE.escapeHtml(String(error)) })}</div>`;
                    return;
                }

                // Show results for multiple regions
                const regionsToSearch = userRegions.length > 0 ? userRegions : [userRegion];

                let hasAnyResults = false;
                const unavailableRegions: string[] = [];

                regionsToSearch.forEach((region, index) => {
                    const regionData = data.results[region];
                    const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

                    if (hasServices) {
                        // Filter services based on user preferences
                        let services = regionData.flatrate;
                        if (userServices.length > 0) {
                            services = services.filter((service: any) =>
                                userServices.includes(service.provider_name)
                            );
                        }

                        if (services.length > 0) {
                            hasAnyResults = true;
                            const regionResult = processRegionData(data, tmdbId, mediaType, region, true);
                            if (regionResult) {
                                if (index > 0 || unavailableRegions.length > 0) {
                                    regionResult.style.marginTop = '6px';
                                }
                                resultContainer.appendChild(regionResult);
                            }
                        } else {
                            unavailableRegions.push(region);
                        }
                    } else {
                        unavailableRegions.push(region);
                    }
                });

                // Show unavailable regions first if there are any
                if (unavailableRegions.length > 0) {
                    const unavailableContainer = createUnavailableRegionsDisplay(unavailableRegions);
                    resultContainer.insertBefore(unavailableContainer, resultContainer.firstChild);
                }

                // If no results found anywhere, show a general message
                if (!hasAnyResults && unavailableRegions.length === 0) {
                    const noServices = document.createElement('div');
                    noServices.style.cssText = 'color: #6c757d; font-size: 13px; margin-top: 8px;';
                    noServices.textContent = JE.t('elsewhere_panel_no_services_in_regions');
                    resultContainer.appendChild(noServices);
                }
            });
        };

        return container;
    }

    // Create display for unavailable regions
    function createUnavailableRegionsDisplay(unavailableRegions: string[]): HTMLElement {
        const container = document.createElement('div');
        container.style.cssText = `
            margin: 0 0 6px 0;
            padding: 12px;
            border-radius: 8px;
            border: 1px solid rgba(139, 19, 19, 0.6);
            background: rgba(139, 19, 19, 0.3);
            backdrop-filter: blur(10px);
            position: relative;
        `;

        // Create header with title and close button
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0;
        `;

        const title = document.createElement('div');
        const regionNames = unavailableRegions.map(region => availableRegions[region] || region);
        const regionText = regionNames.length === 1 ? regionNames[0] :
                          regionNames.length === 2 ? regionNames.join(' and ') :
                          regionNames.slice(0, -1).join(', ') + ' and ' + regionNames[regionNames.length - 1];

        title.textContent = JE.t('elsewhere_panel_not_available_in_regions', { regions: regionText });
        title.style.cssText = `
            font-weight: 600;
            font-size: 14px;
            color: rgb(255, 20, 20);
            flex: 1;
        `;

        // Create close button
        const closeButton = document.createElement('button');
        const closeIcon = createMaterialIcon('close', '16px');
        closeButton.appendChild(closeIcon);
        closeButton.title = 'Close';
        closeButton.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 500ms ease;
            width: 28px;
            height: 28px;
        `;

        closeButton.onmouseenter = () => {
            closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
            closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
        };

        closeButton.onmouseleave = () => {
            closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
            closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        };

        closeButton.onclick = () => {
            container.remove();
        };

        header.appendChild(title);
        header.appendChild(closeButton);
        container.appendChild(header);

        return container;
    }

    // Process streaming data for a specific region
    function processRegionData(data: any, tmdbId: string, mediaType: string, region: string, showAvailable = false): HTMLElement | null {
        const regionData = data.results[region];
        if (!regionData || !regionData.flatrate) {
            return null;
        }

        // Filter services based on user preferences
        const services = regionData.flatrate.filter((service: any) =>
            userServices.length === 0 || userServices.includes(service.provider_name)
        );

        // Don't show container if no services match filters
        if (services.length === 0) {
            return null;
        }

        const container = document.createElement('div');
        container.style.cssText = `
            margin: 10px 0 0 0;
            padding: 12px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            position: relative;
        `;

        // Create header with title and close button
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        `;

        // Create clickable title that links to JustWatch
        const title = extLink(
            regionData.link || '#',
            { title: 'JustWatch' }
        );
        title.textContent = JE.t('elsewhere_panel_available_in_region', { region: availableRegions[region] || region });
        title.style.cssText = `
            font-weight: 600;
            font-size: 14px;
            text-decoration: none;
            cursor: pointer;
            color: #fff;
            flex: 1;
            text-align: left;
        `;

        // Add JustWatch link if available and enabled
        if (regionData.link) {
            title.classList.add('elsewhere-link-reset');
            title.href = regionData.link;
            title.style.padding = '0';
            title.style.margin = '0';
        }

        // Create close button
        const closeButton = document.createElement('button');
        const closeIcon = createMaterialIcon('close', '16px');
        closeButton.appendChild(closeIcon);
        closeButton.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 500ms ease;
            width: 28px;
            height: 28px;
        `;

        closeButton.onmouseenter = () => {
            closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
            closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
        };

        closeButton.onmouseleave = () => {
            closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
            closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        };

        closeButton.onclick = () => {
            container.remove();
        };

        header.appendChild(title);
        header.appendChild(closeButton);
        container.appendChild(header);

        const servicesContainer = document.createElement('div');
        servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px;';

        services.forEach((service: any) => {
            servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
        });

        container.appendChild(servicesContainer);

        return container;
    }

    // Auto-load streaming data (default region only), filling the DETACHED
    // container and signalling readiness so the caller can insert it once.
    function autoLoadStreamingData(tmdbId: string, mediaType: string, container: HTMLElement, onReady: () => void): void {
        fetchStreamingData(tmdbId, mediaType, (error, data) => {
            if (error) {
                const errorDiv = document.createElement('div');
                errorDiv.style.cssText = 'font-size: 13px; margin-top: 8px; color: #ff6b6b;';
                errorDiv.textContent = JE.t('elsewhere_panel_error', { error });
                container.appendChild(errorDiv);
                onReady();
                return;
            }

            // Show default region results automatically
            const defaultResult = processDefaultRegionData(data, tmdbId, mediaType);
            if (defaultResult) {
                container.appendChild(defaultResult);
            }
            onReady();
        });
    }

    // Sections whose Elsewhere panel is still being fetched (off-DOM), so a
    // concurrent observer pass doesn't start a duplicate build for them.
    const pendingElsewhereSections = new WeakSet<Element>();

    // Add buttons to detail pages
    function addStreamingLookup(): void {
        const detailSections = document.querySelectorAll('.detailSectionContent');

        detailSections.forEach(section => {
            // Skip if already processed or in flight
            if (section.querySelector('.streaming-lookup-container')) return;
            if (pendingElsewhereSections.has(section)) return;

            // Look for TMDB link to get ID and media type
            const tmdbLinks = section.querySelectorAll<HTMLAnchorElement>('a[href*="themoviedb.org"]');
            if (tmdbLinks.length === 0) return;

            const tmdbLink = tmdbLinks[0];
            const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
            if (!match) return;

            const mediaType = match[1];
            const tmdbId = match[2];

            // Create container — held OFF-DOM until its content is ready.
            const container = document.createElement('div');
            container.className = 'streaming-lookup-container';
            container.style.cssText = 'margin: 16px 0;';

            // PERF(R7): single insert with content. The old flow inserted the empty
            // container immediately (its 16px margins alone shifted the page)
            // and filled it after the fetch — a second, larger shift. Now the
            // panel is built and filled off-DOM and inserted ONCE, with its
            // margin as part of the inserted block, so the page below the
            // external links moves exactly once.
            pendingElsewhereSections.add(section);
            autoLoadStreamingData(tmdbId, mediaType, container, () => {
                pendingElsewhereSections.delete(section);
                if (!section.isConnected) return; // user navigated away
                if (section.querySelector('.streaming-lookup-container')) return; // dedupe race
                if (container.childNodes.length === 0) return; // nothing to show

                // Insert after external links or at the end
                const externalLinks = section.querySelector('.itemExternalLinks');
                if (externalLinks) {
                    externalLinks.parentNode!.insertBefore(container, externalLinks.nextSibling);
                } else {
                    section.appendChild(container);
                }
            });
        });
    }
    // --- Initialization ---
    loadRegionsAndProviders();
    loadSettings();

    // Use deferred initialization with requestIdleCallback
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => createSettingsModal(), { timeout: 2000 });
    } else {
        setTimeout(createSettingsModal, 2000);
    }

    // Coalesced, idle-scheduled lookup pass shared by every trigger below.
    let processingElsewhere = false;
    function scheduleStreamingLookup(): void {
        if (processingElsewhere) return;
        processingElsewhere = true;
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => {
                addStreamingLookup();
                processingElsewhere = false;
            }, { timeout: 500 });
        } else {
            setTimeout(() => {
                addStreamingLookup();
                processingElsewhere = false;
            }, 100);
        }
    }

    // PERF(R3): this used to be a dedicated body-wide MutationObserver with
    // attributeFilter:['class'] — the filter opted it out of the multiplexer
    // and made it fire on every hover/focus/class write on EVERY page.
    // Structural changes (the detail section / external links mounting) now
    // arrive via the shared multiplexed body observer behind a cheap
    // details-page gate, and the cached-page re-show (a class flip with no
    // structural mutation — the only thing the attribute filter actually
    // caught) is covered by the navigation/viewshow probes below.
    // addStreamingLookup re-validates and de-dupes per section itself.
    // Gate on the VISIBLE details view, never getElementById: up to three
    // cached `#itemDetailPage` elements coexist (v12-platform.md §3) and
    // getElementById returns the lowest slot — usually an old hidden one —
    // which made this gate permanently dead after two details visits. The
    // TMDB external link this feature anchors on only mounts when the host
    // renders item data, so with the gate dead the lookup never ran at all
    // on a slow first visit (only the too-early nav/viewshow probes fired).
    onBodyMutation('elsewhere', () => {
        if (!isDetailsPageVisible()) return;
        scheduleStreamingLookup();
    });
    onNavigate(() => scheduleStreamingLookup());
    onViewPage(() => scheduleStreamingLookup());

    // Initial check
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => addStreamingLookup(), { timeout: 1000 });
    } else {
        setTimeout(addStreamingLookup, 1000);
    }

    console.log('🪼 Jellyfin Elevate: 🎬 Jellyfin Elsewhere loaded!');
};
