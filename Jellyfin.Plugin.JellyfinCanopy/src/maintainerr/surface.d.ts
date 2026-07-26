import type {} from '../types/jc';

declare module '../types/jc' {
    interface JEGlobal {
        /** Stable facade for the native, administrator-only Maintainerr page. */
        maintainerrPage?: import('./page').MaintainerrPageApi;
    }
}
