import {
  Outfit_300Light,
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  Outfit_800ExtraBold,
} from '@expo-google-fonts/outfit';

/**
 * Outfit, the design's typeface, in the six weights it uses.
 *
 * React Native on Android does not synthesise weights for a custom family, so
 * each weight is a separately registered family name rather than a `fontWeight`
 * on one family — which is why `theme/tokens.ts` carries family names and not
 * weights.
 */
export const fontMap = {
  Outfit_300Light,
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  Outfit_800ExtraBold,
};
