import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../../src/components/Icon';
import { Text } from '../../src/components/Text';
import { useOrdersAwaitingConfirmation } from '../../src/features/merchant';
import { useLayout } from '../../src/lib/layout';
import { color, font, radius, TAB_BAR_HEIGHT } from '../../src/theme/tokens';

/**
 * The five tabs of the seller canvas.
 *
 * Only Today is built. The other four are here as routes so the bar is the
 * design's bar from the first build rather than growing a tab at a time — each
 * one says plainly that it is not finished yet, which is a state a seller can
 * read, unlike a tab that renders an empty list as though the shop had no
 * stock.
 */
const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: 'Today', icon: 'home' },
  { name: 'orders', title: 'Orders', icon: 'box' },
  { name: 'products', title: 'Products', icon: 'grid' },
  { name: 'payouts', title: 'Payouts', icon: 'wallet' },
  { name: 'shop', title: 'Shop', icon: 'store' },
];

export default function TabsLayout(): React.ReactElement {
  const { data: awaiting } = useOrdersAwaitingConfirmation();
  const insets = useSafeAreaInsets();
  const toConfirm = awaiting?.total ?? 0;
  const { wide } = useLayout();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.primary,
        tabBarInactiveTintColor: color.mutedTab,
        // A wide window navigates from the bar along the top (`WideNav`).
        tabBarStyle: wide
          ? { display: 'none' }
          : {
              height: TAB_BAR_HEIGHT + insets.bottom,
              paddingTop: 8,
              paddingBottom: insets.bottom,
              backgroundColor: color.surface,
              borderTopColor: color.border,
              borderTopWidth: StyleSheet.hairlineWidth,
              elevation: 0,
            },
        tabBarLabelStyle: { fontFamily: font.medium, fontSize: 10.5, letterSpacing: -0.1 },
        sceneStyle: { backgroundColor: color.canvas },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ color: tint }) => (
              <View>
                <Icon name={tab.icon} size={22} color={tint} />
                {tab.name === 'orders' && toConfirm > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{toConfirm > 9 ? '9+' : toConfirm}</Text>
                  </View>
                ) : null}
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
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
