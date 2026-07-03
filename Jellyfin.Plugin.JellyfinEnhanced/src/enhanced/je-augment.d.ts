// src/enhanced/je-augment.d.ts
//
// Module augmentation adding the enhanced-area public surfaces to the shared
// JEGlobal contract (src/types/je.ts) without editing that file. Every member
// added here is part of the FROZEN window.JellyfinEnhanced contract: legacy
// js/ modules, js/plugin.js and user scripts keep reading these exact names.
//
// Types are deliberately loose where the legacy shapes are (Record/any-ish
// members); they tighten as consumers convert.

import type {} from '../types/je';

declare global {
    interface Window {
        /** Legacy dashboard helper exposed by jellyfin-web. */
        Dashboard?: {
            navigate?: (url: string) => void;
            alert?: (message: string) => void;
            [key: string]: unknown;
        };
    }
}

declare module '../types/je' {
    interface EnhancedRemoveContext {
        itemId: string | null;
        surface: 'continuewatching' | 'nextup' | null;
        ts: number;
        [key: string]: unknown;
    }

    /** Shared mutable state bag (enhanced/config). */
    interface EnhancedState {
        activeShortcuts: Record<string, string>;
        removeContext: EnhancedRemoveContext | null;
        skipToastShown: boolean;
        pauseScreenClickTimer: number | null;
        [key: string]: unknown;
    }

    interface NativeTabsApi {
        register(id: string, title: string, onMount: (panel: HTMLElement) => void, icon?: string): void;
        unregister(id: string): void;
    }

    interface JEGlobal {
        // js/plugin.js bootstrap surface (created before the bundle loads)
        /** Translation lookup — returns the key itself when no translation exists. */
        t?: (key: string, params?: Record<string, unknown>) => string;

        // enhanced/config
        state?: EnhancedState;
        userConfig?: {
            settings?: Record<string, unknown>;
            shortcuts?: { Shortcuts?: unknown } & Record<string, unknown>;
            [key: string]: unknown;
        };
        saveUserSettings?: (fileName: string, settings: unknown) => Promise<void>;
        loadSettings?: () => UserSettings;
        initializeShortcuts?: () => void;
        /** Provided by js/plugin.js (camelCase→PascalCase for C# serialization). */
        toPascalCase?: (value: unknown) => unknown;

        // enhanced/native-tabs
        nativeTabs?: NativeTabsApi;

        // enhanced/icons
        icon?: (name: string) => string;
        IconName?: Record<string, string>;
        icons?: {
            EMOJI: Record<string, string>;
            LUCIDE: Record<string, string>;
            MUI: Record<string, string>;
        };
    }
}
