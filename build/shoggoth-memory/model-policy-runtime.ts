// The exported memory selector consumes an already observed capability profile.
// Provider registry discovery is outside this bundle's authority. These imports
// are normally removed by tree shaking; retain a closed boundary if that changes.
function unavailable(): never { throw new Error("Global provider policy is unavailable to memory"); }
export const resolveEffectiveThinkingProfile = unavailable;
