const STYLE_ID = 'jc-details-layout-styles';

/**
 * Own the responsive details-page layout independently of optional action
 * producers. A new navigation activation supersedes an older style owner;
 * stale cleanup can therefore never remove the current route's adapter.
 */
export function installDetailsLayout(): () => void {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        @media (max-width: 600px) {
            #itemDetailPage .detailRibbon > .mainDetailButtons {
                min-width: 0;
                flex: 1 1 auto;
                flex-wrap: wrap;
            }
        }
    `;
    document.head.appendChild(style);
    return () => {
        if (document.getElementById(STYLE_ID) === style) style.remove();
    };
}
