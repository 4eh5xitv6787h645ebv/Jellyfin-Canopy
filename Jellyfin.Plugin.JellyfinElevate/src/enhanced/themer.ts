// src/enhanced/themer.ts
//
// Theme detection and CSS-variable resolution for supported Jellyfin themes.
// (Converted from js/enhanced/themer.js — bodies semantically identical.)

import { JE } from '../globals';
import { assetUrl } from '../core/asset-urls';

/**
 * A theme's configuration: a unique CSS variable identifying it plus the map
 * of semantic keys to CSS variable names (or null) and their *Fallback values.
 */
type ThemeConfig = {
    name: string;
    uniqueIdentifier: string | null;
    variables: Record<string, string | null>;
};

type ActiveTheme = ThemeConfig & { key: string };

type ThemerApi = {
    supportedThemes: Record<string, ThemeConfig>;
    activeTheme: ActiveTheme | null;
    detectActiveTheme(): ActiveTheme;
    getThemeVariable(variableKey: string, rootStyle?: CSSStyleDeclaration): string;
    getThemeVariables(): Record<string, string>;
    registerTheme(themeKey: string, themeConfig: ThemeConfig): void;
    init(): void;
};

const themer: ThemerApi = {
    supportedThemes: {
        // Jellyfish Theme
        jellyfish: {
            name: 'Jellyfish',
            uniqueIdentifier: '--theme-updated-on',
            variables: {
                panelBg: '--primary-background-transparent',
                panelBgFallback: 'rgba(0,0,0,0.95)',
                secondaryBg: '--secondary-background-transparent',
                secondaryBgFallback: 'rgba(0,0,0,0.2)',
                primaryAccent: '--primary-accent-color',
                primaryAccentFallback: '#00A4DC',
                textColor: '--text-color',
                textColorFallback: '#FFFFFF',
                altAccent: '--alt-accent-color',
                altAccentFallback: '#ffffff20',
                blur: '--blur',
                blurFallback: '20px',
                logo: '--logo',
                logoFallback: ''
            }
        },

        // ElegantFin Theme
        elegantfin: {
            name: 'ElegantFin',
            uniqueIdentifier: '--elegantFinFooterText',
            variables: {
                panelBg: '--headerColor',
                panelBgFallback: 'rgba(30, 40, 54, 0.9)',
                secondaryBg: '--drawerColor',
                secondaryBgFallback: 'rgba(30, 40, 54, 0.8)',
                primaryAccent: '--activeColor',
                primaryAccentFallback: 'rgb(119, 91, 244)',
                textColor: '--textColor',
                textColorFallback: '#FFFFFF',
                altAccent: '--selectorBackgroundColor',
                altAccentFallback: 'rgb(55, 65, 81)',
                blur: '--blurDefault',
                blurFallback: 'blur(5px)',
                logo: null, // ElegantFin doesn't use a separate CSS variable for logo
                logoFallback: ''
            }
        },

        // Zesty Theme
        zesty: {
            name: 'Zesty',
            uniqueIdentifier: '--honey-yellow',
            variables: {
                panelBg: '--darkest',
                panelBgFallback: 'rgba(24, 24, 24, 0.95)',
                secondaryBg: '--dark',
                secondaryBgFallback: 'rgba(32, 32, 32, 0.8)',
                primaryAccent: '--accent',
                primaryAccentFallback: 'rgb(78, 116, 247)',
                textColor: '--white',
                textColorFallback: '#F3F2F3',
                altAccent: '--dark-highlight',
                altAccentFallback: 'rgba(255,255,255,0.1)',
                blur: '--rounding',
                blurFallback: '12px',
                logo: null, // Zesty doesn't use a separate CSS variable for logo
                // PERF(R6): no remote assets — logo served from the local asset cache.
                logoFallback: assetUrl('themer/jellyfin-logo-light.png')
            }
        },

        // Default/fallback theme
        default: {
            name: 'Default',
            uniqueIdentifier: null, // No identifier - this is the fallback
            variables: {
                panelBg: null,
                panelBgFallback: 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))',
                secondaryBg: null,
                secondaryBgFallback: 'rgba(0,0,0,0.2)',
                primaryAccent: null,
                primaryAccentFallback: '#00A4DC',
                textColor: null,
                textColorFallback: '#FFFFFF',
                altAccent: null,
                altAccentFallback: 'rgba(255,255,255,0.1)',
                blur: null,
                blurFallback: '20px',
                logo: null,
                logoFallback: ''
            }
        }
    },

    activeTheme: null,

    /**
     * Detect the currently active theme
     * @returns The detected theme configuration
     */
    detectActiveTheme() {
        const rootStyle = getComputedStyle(document.documentElement);

        // Check each theme by its unique identifier
        for (const [themeKey, theme] of Object.entries(this.supportedThemes)) {
            // Skip if no identifier is found and fallback to default theme
            if (!theme.uniqueIdentifier) continue;

            const identifierValue = rootStyle.getPropertyValue(theme.uniqueIdentifier).trim();

            // If the unique identifier exists and is not empty use the variables from the theme
            if (identifierValue && identifierValue !== '' && identifierValue !== 'none') {
                console.log(`🪼 Jellyfin Elevate: Detected ${theme.name} theme`);
                this.activeTheme = { key: themeKey, ...theme };
                return this.activeTheme;
            }
        }

        // Default fallback
        console.log('🪼 Jellyfin Elevate: Using default theme (no specific theme detected)');
        this.activeTheme = { key: 'default', ...this.supportedThemes.default };
        return this.activeTheme;
    },

    /**
     * Get a theme variable value with fallback
     * @param variableKey - The key from the theme's variables object
     * @returns The CSS value or fallback value
     */
    getThemeVariable(variableKey: string, rootStyle?: CSSStyleDeclaration) {
        if (!this.activeTheme) {
            this.detectActiveTheme();
        }

        const theme = this.activeTheme!;
        const cssVariable = theme.variables[variableKey];
        const fallbackValue = theme.variables[variableKey + 'Fallback'];

        if (!cssVariable) {
            return fallbackValue || '';
        }

        // THEME-7 (R4): reuse a caller-supplied computed style when present so
        // getThemeVariables reads getComputedStyle once, not once per key.
        const style = rootStyle || getComputedStyle(document.documentElement);
        const value = style.getPropertyValue(cssVariable).trim();

        // Special handling for logo variable (URL extraction)
        if (variableKey === 'logo' && value) {
            return value.replace(/url\(['"]?(.*?)['"]?\)/i, '$1');
        }

        // Special handling for RGB values that need wrapping
        if (value && /^\d+,\s*\d+,\s*\d+$/.test(value)) {
            return `rgb(${value})`;
        }

        return value || fallbackValue || '';
    },

    /**
     * Get all theme variables for the current theme
     * @returns Object with all theme variable values
     */
    getThemeVariables() {
        if (!this.activeTheme) {
            this.detectActiveTheme();
        }

        // THEME-7 (R4): read the computed style ONCE and reuse it for every key
        // (was ~7 getComputedStyle reads per call). Safe because a theme switch
        // forces window.location.reload() (theme-selector.ts), so no stale cache.
        const rootStyle = getComputedStyle(document.documentElement);
        const variables: Record<string, string> = {};
        const variableKeys = Object.keys(this.activeTheme!.variables).filter(key => !key.endsWith('Fallback'));

        for (const key of variableKeys) {
            variables[key] = this.getThemeVariable(key, rootStyle);
        }

        return variables;
    },

    /**
     * Register a new theme (useful for adding themes dynamically)
     * @param themeKey - Unique identifier for the theme
     * @param themeConfig - Theme configuration object with uniqueIdentifier and variables
     */
    registerTheme(themeKey: string, themeConfig: ThemeConfig) {
        this.supportedThemes[themeKey] = themeConfig;
        console.log(`🪼 Jellyfin Elevate: Registered theme - ${themeConfig.name} (identifier: ${themeConfig.uniqueIdentifier})`);
    },

    /**
     * Initialize theme detection (runs once on page load)
     */
    init() {
        this.detectActiveTheme();
    }
};

JE.themer = themer;
