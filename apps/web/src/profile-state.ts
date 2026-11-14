import type { AppProfile } from '@kcs/shared';

export type ProfilePatch = Omit<Partial<AppProfile>, 'preferences'> & {
  preferences?: Partial<AppProfile['preferences']>;
};

/** Publish acknowledged fields only while their captured client values still own them.
 * A partial write owns its requested fields and preference keys; a complete read or
 * import may publish every received field without replacing newer local choices. */
export function reconcileProfileAcknowledgement(
  current: AppProfile | null,
  basis: AppProfile | null,
  received: AppProfile,
  patch?: ProfilePatch,
): AppProfile {
  if (!current) return received;
  if (!basis) return current;
  const fields = (patch ? Object.keys(patch) : [...new Set([...Object.keys(basis), ...Object.keys(received)])]) as Array<keyof AppProfile>;
  const acknowledged = Object.fromEntries(fields
    .filter((key) => key !== 'preferences' && (!patch || patch[key] !== undefined)
      && JSON.stringify(current[key]) === JSON.stringify(basis[key]))
    .map((key) => [key, received[key]]));
  const preferenceKeys = (patch ? Object.keys(patch.preferences || {})
    : [...new Set([...Object.keys(basis.preferences), ...Object.keys(received.preferences)])]) as Array<keyof AppProfile['preferences']>;
  const preferences = Object.fromEntries(preferenceKeys
    .filter((key) => (!patch || patch.preferences?.[key] !== undefined)
      && JSON.stringify(current.preferences[key]) === JSON.stringify(basis.preferences[key]))
    .map((key) => [key, received.preferences[key]]));
  return { ...current, ...acknowledged, preferences: { ...current.preferences, ...preferences } };
}
