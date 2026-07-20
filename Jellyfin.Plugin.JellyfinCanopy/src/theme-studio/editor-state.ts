import type { ThemeProfile, UserThemeConfiguration } from '../types/jc';
import { parseUserThemeConfiguration } from './schema';

const HISTORY_LIMIT = 50;
export const THEME_PROFILE_NAME_MAX_LENGTH = 80;
export const THEME_PROFILE_MAX_COUNT = 24;

export function isValidThemeProfileName(name: string): boolean {
    const cleanName = name.trim();
    return cleanName.length > 0
        && [...cleanName].length <= THEME_PROFILE_NAME_MAX_LENGTH
        && !/[\u0000-\u001f\u007f-\u009f]/.test(cleanName);
}

function cloneConfiguration(value: UserThemeConfiguration): UserThemeConfiguration {
    return JSON.parse(JSON.stringify(value)) as UserThemeConfiguration;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function profileSlug(name: string): string {
    const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
    return /^[a-z]/.test(slug) ? slug : `theme-${slug || 'profile'}`;
}

function uniqueProfileId(name: string, profiles: readonly ThemeProfile[]): string {
    const existing = new Set(profiles.map((profile) => profile.Id));
    const base = profileSlug(name);
    if (!existing.has(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
        const suffix = `-${index}`;
        const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        if (!existing.has(candidate)) return candidate;
    }
    return `theme-${Date.now().toString(36)}`;
}

export interface ThemeEditorSnapshot {
    readonly configuration: UserThemeConfiguration;
    readonly dirty: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}

/** Pure, bounded state machine shared by pointer, keyboard and import workflows. */
export class ThemeEditorState {
    #committed: UserThemeConfiguration;
    #draft: UserThemeConfiguration;
    readonly #past: UserThemeConfiguration[] = [];
    readonly #future: UserThemeConfiguration[] = [];

    constructor(configuration: UserThemeConfiguration) {
        const parsed = parseUserThemeConfiguration(configuration);
        if (!parsed) throw new TypeError('Theme editor requires a valid configuration');
        this.#committed = parsed;
        this.#draft = cloneConfiguration(parsed);
    }

    snapshot(): ThemeEditorSnapshot {
        return Object.freeze({
            configuration: cloneConfiguration(this.#draft),
            dirty: canonical(this.#draft) !== canonical(this.#committed),
            canUndo: this.#past.length > 0,
            canRedo: this.#future.length > 0,
        });
    }

    matchesCommitted(value: unknown): boolean {
        const parsed = parseUserThemeConfiguration(value);
        return parsed !== null && canonical(parsed) === canonical(this.#committed);
    }

    activeProfile(): ThemeProfile {
        return cloneConfiguration(this.#draft).Profiles
            .find((profile) => profile.Id === this.#draft.ActiveProfileId)!;
    }

    mutate(change: (configuration: UserThemeConfiguration) => void): boolean {
        const candidate = cloneConfiguration(this.#draft);
        change(candidate);
        const parsed = parseUserThemeConfiguration(candidate);
        if (!parsed || canonical(parsed) === canonical(this.#draft)) return false;
        this.#past.push(cloneConfiguration(this.#draft));
        if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
        this.#future.length = 0;
        this.#draft = parsed;
        return true;
    }

    replace(value: unknown): boolean {
        const parsed = parseUserThemeConfiguration(value);
        return parsed ? this.mutate((draft) => Object.assign(draft, parsed)) : false;
    }

    undo(): boolean {
        const previous = this.#past.pop();
        if (!previous) return false;
        this.#future.push(cloneConfiguration(this.#draft));
        this.#draft = previous;
        return true;
    }

    redo(): boolean {
        const next = this.#future.pop();
        if (!next) return false;
        this.#past.push(cloneConfiguration(this.#draft));
        this.#draft = next;
        return true;
    }

    discard(): void {
        this.#draft = cloneConfiguration(this.#committed);
        this.#past.length = 0;
        this.#future.length = 0;
    }

    adoptCommitted(value: UserThemeConfiguration): boolean {
        const parsed = parseUserThemeConfiguration(value);
        if (!parsed) return false;
        this.#committed = parsed;
        this.#draft = cloneConfiguration(parsed);
        this.#past.length = 0;
        this.#future.length = 0;
        return true;
    }

    updateActiveProfile(change: (profile: ThemeProfile) => void): boolean {
        return this.mutate((draft) => {
            const profile = draft.Profiles.find((item) => item.Id === draft.ActiveProfileId);
            if (profile) change(profile);
        });
    }

    switchProfile(id: string): boolean {
        return this.mutate((draft) => {
            if (draft.Profiles.some((profile) => profile.Id === id)) draft.ActiveProfileId = id;
        });
    }

    addProfile(name: string): boolean {
        const cleanName = name.trim();
        if (!isValidThemeProfileName(cleanName)
            || this.#draft.Profiles.length >= THEME_PROFILE_MAX_COUNT) return false;
        return this.mutate((draft) => {
            const source = draft.Profiles.find((profile) => profile.Id === draft.ActiveProfileId);
            const profile = JSON.parse(JSON.stringify(source)) as ThemeProfile;
            profile.Id = uniqueProfileId(cleanName, draft.Profiles);
            profile.Name = cleanName;
            draft.Profiles.push(profile);
            draft.ActiveProfileId = profile.Id;
        });
    }

    renameActiveProfile(name: string): boolean {
        return this.renameProfile(this.#draft.ActiveProfileId, name);
    }

    renameProfile(id: string, name: string): boolean {
        const cleanName = name.trim();
        if (!isValidThemeProfileName(cleanName)) return false;
        return this.mutate((draft) => {
            const profile = draft.Profiles.find((item) => item.Id === id);
            if (profile) profile.Name = cleanName;
        });
    }

    resetActiveProfile(preset: string, palette: string): boolean {
        return this.updateActiveProfile((profile) => {
            profile.BasePreset = preset;
            profile.PresetVersion = null;
            profile.FreezePresetVersion = false;
            profile.Palette = palette;
            profile.Accent = 'palette';
            profile.Mode = 'system';
            profile.Tokens = {};
            profile.Responsive = { Phone: null, Tablet: null, Desktop: null, Wide: null, Tv: null };
            profile.Accessibility = {
                Motion: 'system',
                Contrast: 'system',
                Transparency: 'system',
                FocusEmphasis: 'system',
                UnderlineLinks: false,
            };
        });
    }

    deleteActiveProfile(): boolean {
        if (this.#draft.Profiles.length <= 1) return false;
        return this.mutate((draft) => {
            const removed = draft.ActiveProfileId;
            draft.Profiles = draft.Profiles.filter((profile) => profile.Id !== removed);
            draft.ActiveProfileId = draft.Profiles[0].Id;
            draft.Schedule = draft.Schedule.filter((entry) => entry.ProfileId !== removed);
        });
    }
}
