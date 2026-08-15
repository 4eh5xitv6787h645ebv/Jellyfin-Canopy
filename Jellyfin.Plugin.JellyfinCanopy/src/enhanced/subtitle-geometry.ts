/** Apply the production container geometry for a bottom-anchored cue box. */
export function applySubtitleContainerGeometry(container: HTMLElement, yPct: number): void {
    container.style.setProperty('position', 'absolute', 'important');
    container.style.setProperty('left', '0', 'important');
    container.style.setProperty('right', 'auto', 'important');
    container.style.setProperty('top', `${yPct}%`, 'important');
    container.style.setProperty('bottom', 'auto', 'important');
    container.style.setProperty('transform', 'translateY(-100%)', 'important');
    container.style.setProperty('width', '100%', 'important');
    container.style.setProperty('max-width', 'none', 'important');
    container.style.setProperty('text-align', 'center', 'important');
}

/** Keep a center-anchored cue inside the video at every supported x position. */
export function applyCueGeometry(element: HTMLElement, xPct: number): void {
    const edgeDistance = Math.min(xPct, 100 - xPct);
    const maxCueWidth = Math.min(70, edgeDistance * 2);
    element.style.setProperty('position', 'relative', 'important');
    element.style.setProperty('left', `${xPct - 50}%`, 'important');
    element.style.setProperty('right', 'auto', 'important');
    element.style.setProperty('top', 'auto', 'important');
    element.style.setProperty('bottom', 'auto', 'important');
    element.style.setProperty('transform', 'none', 'important');
    element.style.setProperty('width', 'auto', 'important');
    element.style.setProperty('max-width', `${maxCueWidth}%`, 'important');
    element.style.setProperty('box-sizing', 'border-box', 'important');
    element.style.setProperty('margin-top', '0', 'important');
    element.style.setProperty('margin-right', '0', 'important');
    element.style.setProperty('margin-bottom', '0', 'important');
    element.style.setProperty('margin-left', '0', 'important');
}
