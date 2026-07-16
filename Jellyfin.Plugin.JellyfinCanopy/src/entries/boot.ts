// Boot-critical platform only. Feature implementations remain outside this
// graph and are imported through their manifest descriptors on demand.
import type { JellyfinCanopyPublicApi } from '../facade';
import type { JEGlobal } from '../types/jc';
import '../core/navigation';
import '../core/layout';
import '../core/lifecycle';
import '../core/dom-observer';
import '../core/ui-kit';
import '../core/api-client';
import '../core/identity';
import '../core/live';
import '../core/live-config';
import '../core/live-update';
import '../enhanced/config';
import '../enhanced/helpers';
import '../enhanced/icons';
import { initPagesFramework } from '../enhanced/pages';
import '../enhanced/themer';
import {
    builtInFeatureDescriptors,
} from './feature-catalog';
import {
    initializeClientRuntime as initializeRuntime,
    registerFeatureDescriptors,
    type ClientRuntime,
    type ClientRuntimeOptions,
} from '../core/client-runtime';

type FrozenPublicApi = JEGlobal extends JellyfinCanopyPublicApi ? true : never;
const publicApiContractIsFrozen: FrozenPublicApi = true;
void publicApiContractIsFrozen;

let descriptorsRegistered = false;

/** Initialize the singleton runtime and atomically install the built-in catalog once. */
export function initializeClientRuntime(options: ClientRuntimeOptions): ClientRuntime {
    const runtime = initializeRuntime(options);
    // The lazy page entries own only their route-scoped renderers. Their
    // permanent router, fallback-rewrite and entry-point hooks remain boot
    // infrastructure and must be wired before the first descriptor activation.
    initPagesFramework();
    if (!descriptorsRegistered) {
        runtime.registerFeatureDescriptors(builtInFeatureDescriptors);
        descriptorsRegistered = true;
    }
    return runtime;
}

export {
    registerFeatureDescriptors,
    type ClientFeatureDescriptor,
    type ClientManifest,
    type ClientRuntime,
    type ClientRuntimeOptions,
} from '../core/client-runtime';
export { clientEntryContract } from './entry-contract';
