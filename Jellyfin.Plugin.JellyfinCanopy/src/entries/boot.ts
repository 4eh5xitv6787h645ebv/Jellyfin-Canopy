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

export {
    initializeClientRuntime,
    registerFeatureDescriptors,
    type ClientFeatureDescriptor,
    type ClientManifest,
    type ClientRuntime,
    type ClientRuntimeOptions,
} from '../core/client-runtime';
export { clientEntryContract } from './entry-contract';
