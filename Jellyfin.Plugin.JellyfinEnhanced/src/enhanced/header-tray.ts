// src/enhanced/header-tray.ts
//
// Pure, side-effect-free helpers for the header-right button tray. Kept out of
// enhanced/helpers.ts (which assigns JE.helpers on import) so a consumer can use
// them without pulling in that module's initialisation.

/**
 * Stable header-tray slot priorities (lower sorts earlier / more leading). Each
 * independent header-tray injector claims a distinct slot so the final order is
 * deterministic regardless of which injector's retry/observer won the race.
 * Keep values distinct and spaced so new injectors can slot between.
 */
export const HeaderTrayOrder = {
    activeStreams: 10,
    randomButton: 20,
} as const;

/**
 * Insert a JE button into the header-right tray at a deterministic position.
 *
 * Multiple injectors (random button, active streams) previously each prepended
 * to the same container via independent retries, so whichever ran last took the
 * leading slot — a nondeterministic order. This keeps JE tray buttons as a
 * leading group sorted by ascending {@link HeaderTrayOrder}, with the native
 * buttons after them, no matter the injection order. Re-inserting an element
 * already present just repositions it.
 * @param container The header-right tray (see getHeaderRightContainer).
 * @param el The button to insert.
 * @param order Stable priority from {@link HeaderTrayOrder} (lower = more leading).
 */
export function insertHeaderTrayButton(container: HTMLElement, el: HTMLElement, order: number): void {
    el.dataset.jeTrayOrder = String(order);
    let ref: Element | null = null;
    for (const child of Array.from(container.children)) {
        if (child === el) continue;
        const childOrder = (child as HTMLElement).dataset?.jeTrayOrder;
        // Stop before the first native (non-JE) element, or the first JE tray
        // button whose order is greater than ours — that's our sorted slot.
        if (childOrder === undefined || Number(childOrder) > order) {
            ref = child;
            break;
        }
    }
    container.insertBefore(el, ref);
}
