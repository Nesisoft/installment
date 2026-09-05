/**
 * Ejua Sell design tokens, lifted from the merchant design canvas
 * (`docs/design/Design Prototypes/Ejua Sell (merchant).html`). Every colour,
 * radius and type step the app uses lives here — a screen that invents its own
 * hex is a screen that has drifted from the design.
 *
 * The palette is the same warm-neutral (bone/clay) family as the shopper app,
 * because the two are one product seen from two sides. What differs is which
 * colour leads: the shopper app's accent is crimson, and here it is
 * {@link color.primary} green — a seller's screens are about money coming in,
 * and every primary action in the canvas is green.
 *
 * Deliberately duplicated rather than shared with `apps/customer-mobile`.
 * Hoisting one token module into a package would make every shopper screen
 * depend on a file the seller app also edits, and the two canvases are allowed
 * to diverge — a shared module would make each divergence a negotiation. The
 * cost is one colour table in two places; the benefit is that each app's tokens
 * are exactly its own canvas.
 */

export const color = {
  // Ink & type
  ink: '#0E0D0B',
  inkSoft: '#3C362F',
  muted: '#7A736B',
  mutedSoft: '#9A928A',
  mutedTab: '#8C857C',

  // Light surfaces
  canvas: '#F5F2ED',
  surface: '#FFFFFF',
  surfaceWarm: '#FAF7F2',
  surfaceSunk: '#F2EEE7',

  // Borders / hairlines
  border: '#E4DED4',
  borderSoft: '#EFEAE1',
  borderStrong: '#E0DAD1',

  /**
   * Primary (green). Every call to action in the seller canvas — "List a
   * product", "Confirm order", "Publish to marketplace" — and the money that
   * has landed. In the shopper app this same hex is `success`; here it leads.
   */
  primary: '#0F8B5E',
  primaryDark: '#0B6B48',
  primaryTint: '#E6F3EE',
  primaryLine: '#CFE4DA',
  /** The deepest green, behind a white number on the payout hero. */
  primaryDeep: '#12291F',

  /**
   * Accent (crimson). The shopper app's lead colour, kept here for the few
   * places the seller sees the marketplace's own voice — a count that needs
   * answering, a plan that has fallen behind.
   */
  accent: '#D6165A',
  accentDark: '#A80F44',
  accentTint: '#FDF1F5',

  /** Reserve, and anything held rather than lost. */
  warn: '#E8B21A',
  warnDeep: '#8A6A00',
  warnTint: '#FFF6E3',

  /** Instalment plans in flight — Ejua's money out, not the seller's. */
  info: '#2A52C7',
  infoTint: '#EEF4FF',

  // Dark surfaces (the today hero, the payout hero, sheets' scrim)
  dark: '#0E0D0B',
  darkCanvas: '#1A1815',
  darkRaised: '#1D1A17',
  darkHover: '#26221E',
  darkLine: '#2E2A26',
  darkBorder: '#302C28',
  onDark: '#FFFDF9',
  onDarkMuted: '#A79E94',
  onDarkSoft: '#8C837A',
  onDarkFaint: '#6E655C',

  scrim: 'rgba(14, 13, 11, 0.55)',
} as const;

/**
 * Product-tile tints. The catalogue has no art direction of its own yet, so a
 * product without an image gets a stable tint derived from its id rather than a
 * grey box — the best-sellers list reads as stock instead of a loading state.
 */
export const productTints = [
  '#EFE0E4',
  '#DDE3E6',
  '#F0E6DA',
  '#E2E7DF',
  '#E9E1D6',
  '#E4E0EA',
  '#EFEAD8',
  '#DFE7EC',
] as const;

export function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return productTints[Math.abs(hash) % productTints.length] as string;
}

export const radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 26,
  pill: 999,
} as const;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 26,
  xxxl: 34,
} as const;

/**
 * Outfit is the design's typeface. `font.*` names map to the files registered
 * in `src/theme/fonts.ts`; weight is carried by the family name because React
 * Native on Android does not synthesise weights for a custom family.
 */
export const font = {
  light: 'Outfit_300Light',
  regular: 'Outfit_400Regular',
  medium: 'Outfit_500Medium',
  semibold: 'Outfit_600SemiBold',
  bold: 'Outfit_700Bold',
  extrabold: 'Outfit_800ExtraBold',
} as const;

/** Type steps used by the design, with their tracking. */
export const type = {
  display: { fontFamily: font.extrabold, fontSize: 40, lineHeight: 42, letterSpacing: -1.6 },
  h1: { fontFamily: font.extrabold, fontSize: 28, letterSpacing: -1 },
  h2: { fontFamily: font.bold, fontSize: 21, letterSpacing: -0.6 },
  h3: { fontFamily: font.semibold, fontSize: 16.5, letterSpacing: -0.3 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  bodyMedium: { fontFamily: font.medium, fontSize: 15 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  smallMedium: { fontFamily: font.medium, fontSize: 13 },
  tiny: { fontFamily: font.medium, fontSize: 11.5 },
  /** All-caps eyebrow labels ("NEEDS YOUR ACTION", "SOLD TODAY · 3 SEP"). */
  eyebrow: { fontFamily: font.bold, fontSize: 9.5, letterSpacing: 1.5 },
  eyebrowLg: { fontFamily: font.bold, fontSize: 11, letterSpacing: 1.3 },
  /** A money figure inside a row, rather than a hero. */
  price: { fontFamily: font.bold, fontSize: 17, letterSpacing: -0.4 },
} as const;

export const shadow = {
  card: {
    shadowColor: '#0E0D0B',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#0E0D0B',
    shadowOpacity: 0.1,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
} as const;

/** Height of the bottom tab bar, excluding the safe-area inset. */
export const TAB_BAR_HEIGHT = 58;

/**
 * Absolute fill as a plain object.
 *
 * React Native 0.86 exports `StyleSheet.absoluteFill` as a registered style id
 * and dropped `absoluteFillObject` from the typed surface — an id cannot be
 * spread into an inline style, so overlays declare the four edges here instead.
 */
export const fillParent = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;
