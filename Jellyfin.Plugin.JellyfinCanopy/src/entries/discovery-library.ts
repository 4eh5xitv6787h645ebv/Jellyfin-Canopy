/** Route-only Discovery/Trending feature entry. Importing it performs no work. */
export const discoveryLibraryDependencies = Object.freeze(['seerr-core'] as const);

export {
    activate,
    discoveryLibraryFeature,
    isDiscoveryEnabled,
    isDiscoveryLibraryRoute,
} from '../discovery';
