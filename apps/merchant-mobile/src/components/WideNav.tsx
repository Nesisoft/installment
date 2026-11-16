import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useSegments } from 'expo-router';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { useOrdersAwaitingConfirmation } from '../features/merchant';
import { CONTENT_MAX } from '../lib/layout';
import { color, font, radius, space } from '../theme/tokens';

/** The tab bar's destinations, in its order. */
const LINKS: { route: string; href: string; title: string; icon: IconName }[] = [
  { route: 'index', href: '/', title: 'Today', icon: 'home' },
  { route: 'orders', href: '/orders', title: 'Orders', icon: 'box' },
  { route: 'products', href: '/products', title: 'Products', icon: 'grid' },
  { route: 'payouts', href: '/payouts', title: 'Payouts', icon: 'wallet' },
  { route: 'shop', href: '/shop', title: 'Shop', icon: 'store' },
];

/**
 * Which top-level destination the current route belongs to, for highlighting.
 * A tab is `(tabs)/<name>`; a screen pushed on top is matched by its first
 * segment, so an order's page lights up "Orders" and a plan's lights "Today",
 * which is where the plans list is reached from.
 */
export function activeSection(segments: string[]): string {
  if (segments[0] === '(tabs)') return segments[1] ?? 'index';
  const first = segments[0] ?? 'index';
  if (first === 'plans' || first === 'performance') return 'index';
  if (first === 'statements' || first === 'payout-account') return 'payouts';
  if (first === 'returns') return 'orders';
  if (first === 'change-password') return 'shop';
  return first;
}

/**
 * The top navigation bar on a wide window, standing in for the tab bar.
 *
 * The tabs' destinations in the tabs' order, the count of orders waiting for
 * the seller on Orders as the tab bar shows it, and the one thing a seller does
 * most from a desk — listing a product — as the bar's only button. It sits
 * above every screen rather than inside the tabs, so an order or a plan keeps
 * the way back to everything else.
 */
export function WideNav(): React.ReactElement {
  const segments = useSegments() as string[];
  const section = activeSection(segments);
  const { data: awaiting } = useOrdersAwaitingConfirmation();
  const toConfirm = awaiting?.total ?? 0;

  return (
    <View style={styles.bar} accessibilityRole="header">
      <View style={styles.inner}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Ejua Sell, today"
          onPress={() => router.navigate('/')}
          style={styles.brand}
        >
          <Text style={styles.ejua}>ejua</Text>
          <Text style={styles.sell}>sell</Text>
        </Pressable>

        <View style={styles.links} accessibilityRole="menubar">
          {LINKS.map((link) => {
            const active = section === link.route;
            const tint = active ? color.onDark : color.onDarkMuted;
            return (
              <Pressable
                key={link.route}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
                accessibilityLabel={
                  link.route === 'orders' && toConfirm > 0
                    ? `Orders, ${toConfirm} to confirm`
                    : link.title
                }
                onPress={() => router.navigate(link.href as never)}
                style={[styles.link, active && styles.linkActive]}
              >
                <Icon name={link.icon} size={17} color={tint} />
                <Text variant="smallMedium" style={{ color: tint }}>
                  {link.title}
                </Text>
                {link.route === 'orders' && toConfirm > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{toConfirm > 9 ? '9+' : toConfirm}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/products/new')}
          style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
        >
          <Icon name="plus" size={16} color={color.onDark} />
          <Text variant="smallMedium" tone="onDark">
            List a product
          </Text>
        </Pressable>
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
  brand: { flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingVertical: space.xs },
  ejua: { fontFamily: font.extrabold, fontSize: 24, color: color.onDark, letterSpacing: -1 },
  sell: { fontFamily: font.bold, fontSize: 12, color: color.primary, letterSpacing: -0.2 },
  links: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  linkActive: { backgroundColor: color.darkHover },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: font.bold, fontSize: 10, color: color.onDark },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.primary,
    borderRadius: radius.pill,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
  },
  pressed: { opacity: 0.8 },
});
