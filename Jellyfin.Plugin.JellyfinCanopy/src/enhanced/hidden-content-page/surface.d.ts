// src/enhanced/hidden-content-page/surface.d.ts
//
// JEGlobal surface owned by the hidden-content-page modules. The
// HiddenContentPageApi shape lives next to the facade in page.ts (mirroring
// CalendarPageApi); here we only widen JEGlobal to carry it and the pre-fetched
// host user the admin gate reads.

import type {} from '../../types/jc';

declare module '../../types/jc' {
    interface JEGlobal {
        hiddenContentPage?: import('./page').HiddenContentPageApi;
        /** Pre-fetched host user (jellyfin-web), read for the admin gate. */
        currentUser?: { Policy?: { IsAdministrator?: boolean }; [key: string]: unknown };
    }
}
