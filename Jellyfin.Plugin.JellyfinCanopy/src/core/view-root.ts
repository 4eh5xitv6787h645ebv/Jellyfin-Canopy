// src/core/view-root.ts
//
// Compatibility facade: navigation owns raw view lifecycle capture and the
// exact native-page ownership ledger, so all consumers share one boot chunk.
export {
    queryElementsById,
    recordViewRootShown,
    resetViewRootTrackingForTests,
    resolveCurrentViewRoot,
    type CurrentViewRoot,
} from './navigation';
