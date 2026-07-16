// Import-pure logical entry. Runtime registration/build mapping is owned by the
// #318 integration layer; importing this barrel alone performs no feature work.
export {
    activate,
    cardTagsEligibility,
    cardTagsFeature,
    isCardTagsApplicable,
    isCardTagsEnabled,
} from './feature';
