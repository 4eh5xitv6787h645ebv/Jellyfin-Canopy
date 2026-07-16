// Boot-critical platform only. Feature implementations remain outside this
// graph and are imported through their manifest descriptors on demand.
import '../core/navigation';
import '../core/lifecycle';
import '../core/dom-observer';
import '../core/ui-kit';
import '../core/api-client';
import '../core/identity';
import '../core/live';
import '../core/live-config';
import '../enhanced/config';
import {
    builtInFeatureDescriptors,
} from './feature-catalog';
import {
    initializeClientRuntime as initializeRuntime,
    registerFeatureDescriptors,
    type ClientRuntime,
    type ClientRuntimeOptions,
} from '../core/client-runtime';

let descriptorsRegistered = false;

/** Initialize the singleton runtime and atomically install the built-in catalog once. */
export function initializeClientRuntime(options: ClientRuntimeOptions): ClientRuntime {
    const runtime = initializeRuntime(options);
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
