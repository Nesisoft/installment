import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useSegments } from 'expo-router';
import { useAuth } from '@installment/mobile-kit';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { useCart } from '../features/shop';
import { useCredit } from '../features/account';
import { ghs } from '../lib/format';
import { CONTENT_MAX } from '../lib/layout';
import { color, font, radius, space } from '../theme/tokens';

/** The tab bar's destinations, in its order. The cart has its own button on the right. */
const LINKS: { route: string; href: string; title: string; icon: IconName }[] = [
  { route: 'index', href: '/', title: 'Home', icon: 'home' },
  { route: 'browse', href: '/browse', title: 'Browse', icon: 'grid' },
  { route: 'orders', href: '/orders', title: 'Orders', icon: 'box' },
  { route: 'account', href: '/account', title: 'Account', icon: 'user' },
];

/**
 * Which top-level destination the current route belongs to, for highlighting.
 * A tab screen is `(tabs)/<name>`; anything pushed on top (a product, an order)
 * is matched by its first segment, so an order's page lights up "Orders".
 */
export function activeSection(segments: string[]): string {
  if (segments[0] === '(tabs)') return segments[1] ?? 'index';
  return segments[0] ?? 'index';
}

/**
 * The top navigation bar on a wide window, standing in for the tab bar.
 *
 * Same destinations as the tabs, in the same order, on the same dark ground as
 * the home screen's own header, so a shopper who uses both the app and the
 * site recognises one product. It sits above every screen rather than inside
 * the tabs, so a product or an order keeps the way back to everything else.
 */
export function WideNav(): React.ReactElement {
  const segments = useSegments() as string[];
  const section = activeSection(segments);
  const { signedIn } = useAuth();
  const { data: cart } = useCart(signedIn);
  const credit = useCredit(signedIn);
  const cartCount = cart?.item_count ?? 0;

  return (
    <View style={styles.bar} accessibilityRole="header">
      <View style={styles.inner}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Ejua home"
          onPress={() => router.navigate('/')}
          style={styles.brand}
        >
          <Text style={styles.wordmark}>ejua</Text>
        </Pressable>

        <View style={styles.links} accessibilityRole="menubar">
          {LINKS.map((link) => {
            const active = section === link.route;
            return (
              <Pressable
                key={link.route}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
                onPress={() => router.navigate(link.href as never)}
                style={[styles.link, active && styles.linkActive]}
              >
                <Icon
                  name={link.icon}
                  size={17}
                  color={active ? color.onDark : color.onDarkMuted}
                />
                <Text
                  variant="smallMedium"
                  style={{ color: active ? color.onDark : color.onDarkMuted }}
                >
                  {link.title}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="search"
          accessibilityLabel="Search products"
          onPress={() => router.push('/search')}
          style={styles.search}
        >
          <Icon name="search" size={16} color={color.muted} />
          <Text variant="small" tone="muted" numberOfLines={1}>
            Search the marketplace
          </Text>
        </Pressable>

        <View style={styles.actions}>
          {signedIn ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open your wallet and payments"
              onPress={() => router.push('/wallet')}
              style={styles.wallet}
            >
              {/* Same wording as the home header: "never scored" is not "spent it all". */}
              <Text variant="eyebrow" tone="onDarkFaint">
                {credit.data?.has_limit ? 'LIMIT LEFT' : 'INSTALMENTS'}
              </Text>
              <Text variant="smallMedium" tone="onDark">
                {!credit.data
                  ? '—'
                  : credit.data.has_limit
                    ? ghs(credit.data.available_pesewas)
                    : 'Check yours'}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push('/onboarding')}
              style={styles.signIn}
            >
              <Text variant="smallMedium" tone="onDark">
                Sign in
              </Text>
            </Pressable>
          )}

          <Pressable
            accessibilityRole="link"
            accessibilityLabel={cartCount > 0 ? `Cart, ${cartCount} items` : 'Cart'}
            onPress={() => router.navigate('/cart')}
            style={[styles.cart, section === 'cart' && styles.linkActive]}
          >
            <Icon name="bag" size={19} color={color.onDark} />
            {cartCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{cartCount > 9 ? '9+' : cartCount}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.dark,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.darkLine,
  },
  inner: {
    width: '100%',
    maxWidth: CONTENT_MAX,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  brand: { paddingVertical: space.xs },
  wordmark: { fontFamily: font.extrabold, fontSize: 26, letterSpacing: -1, color: color.onDark },
  links: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  linkActive: { backgroundColor: color.darkHover },
  search: {
    flex: 1,
    minWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  wallet: {
    paddingVertical: 6,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.darkBorder,
  },
  signIn: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.darkBorder,
  },
  cart: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: font.bold, fontSize: 9.5, color: color.onDark },
});
