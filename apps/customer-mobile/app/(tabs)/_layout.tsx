import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@installment/mobile-kit';
import { Icon, type IconName } from '../../src/components/Icon';
import { Text } from '../../src/components/Text';
import { useCart } from '../../src/features/shop';
import { color, font, radius, TAB_BAR_HEIGHT } from '../../src/theme/tokens';

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'browse', title: 'Browse', icon: 'grid' },
  { name: 'cart', title: 'Cart', icon: 'bag' },
  { name: 'orders', title: 'Orders', icon: 'box' },
  { name: 'account', title: 'Account', icon: 'user' },
];

export default function TabsLayout(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { signedIn } = useAuth();
  const { data: cart } = useCart(signedIn);
  const cartCount = cart?.item_count ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.mutedTab,
        tabBarStyle: {
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
                {tab.name === 'cart' && cartCount > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{cartCount > 9 ? '9+' : cartCount}</Text>
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
