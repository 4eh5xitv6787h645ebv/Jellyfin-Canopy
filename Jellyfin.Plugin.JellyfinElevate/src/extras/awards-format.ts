// src/extras/awards-format.ts
//
// Pure, dependency-free formatting helpers for the Awards section, split out so
// they can be unit-tested without loading the DOM/JE module graph.

/** One award as returned by the server (Model/Awards/AwardEntry.cs). */
export interface AwardEntry {
    ceremony: string;
    category: string;
    year?: number | null;
    won: boolean;
}

/**
 * Strips the redundant ceremony prefix from a Wikidata category label so the UI shows
 * "Best Picture" under the "Academy Awards" heading, not "Academy Award for Best Picture".
 * Falls back to the raw label when no known shape matches.
 */
export function prettifyCategory(category: string, ceremony: string): string {
    let c = (category || '').trim();

    // "<anything> Award(s) for X" / "Award – X" → "X" (Oscars, Globes, BAFTA, Emmy, Critics', SAG).
    const awardFor = c.match(/\bAwards?\s+for\s+(.+)$/i);
    if (awardFor) {
        c = awardFor[1].trim();
    } else if (ceremony && c.toLowerCase().startsWith(ceremony.toLowerCase())) {
        // Festival prizes: "Cannes Film Festival Grand Prix" → "Grand Prix".
        c = c.slice(ceremony.length).replace(/^[\s:–-]+/, '').trim() || c;
    }

    return c.length > 0 ? c : category;
}

/** Groups awards by ceremony, preserving first-seen (already newest-first) order. */
export function groupByCeremony(awards: AwardEntry[]): Array<{ ceremony: string; entries: AwardEntry[] }> {
    const order: string[] = [];
    const map = new Map<string, AwardEntry[]>();
    for (const a of awards) {
        const key = a.ceremony || 'Awards';
        let list = map.get(key);
        if (!list) {
            list = [];
            map.set(key, list);
            order.push(key);
        }
        list.push(a);
    }
    return order.map(ceremony => ({ ceremony, entries: map.get(ceremony)! }));
}
