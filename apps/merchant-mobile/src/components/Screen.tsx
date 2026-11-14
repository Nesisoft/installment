import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Text } from './Text';
import { Icon } from './Icon';
import { color, space, TAB_BAR_HEIGHT } from '../theme/tokens';
import { pageMaxWidth, useLayout, type PageWidth } from '../lib/layout';

export interface ScreenProps {
  children: React.ReactNode;
  /** Dark screens (the today hero, the payout hero) paint their own ground. */
  dark?: boolean;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Leaves room for the tab bar; set on the tab screens. */
  tabBar?: boolean;
  /** Leaves room for a sticky footer of this height. */
  footerHeight?: number;
  /**
   * How wide the content may grow on a wide window: the reading width, or the
   * narrower column sign-in and sign-up use. No effect on a phone.
   */
  width?: PageWidth;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Centres a page's content on a wide window and caps its width, while the
 * background it sits on still runs edge to edge. On a phone it is a no-op, so
 * the phone design is untouched.
 */
export function pageColumn(wide: boolean, page?: PageWidth): ViewStyle | undefined {
  const maxWidth = pageMaxWidth(wide, page);
  return maxWidth === undefined ? undefined : { width: '100%', maxWidth, alignSelf: 'center' };
}

export function Screen({
  children,
  dark,
  scroll = true,
  refreshing,
  onRefresh,
  tabBar,
  footerHeight = 0,
  width,
  style,
  contentStyle,
}: ScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const column = pageColumn(layout.wide, width);
  const background = dark ? color.dark : color.canvas;
  // A wide window has no tab bar to clear: navigation is along the top.
  const clearsTabBar = tabBar && !layout.wide;
  const bottomPad =
    (clearsTabBar ? TAB_BAR_HEIGHT + insets.bottom : insets.bottom) + footerHeight + space.lg;

  if (!scroll) {
    return (
      <View style={[styles.flex, { backgroundColor: background }, style]}>
        {column ? <View style={[styles.flex, column]}>{children}</View> : children}
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: background }, style]}
      contentContainerStyle={[{ paddingBottom: bottomPad }, column, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={Boolean(refreshing)}
            onRefresh={onRefresh}
            tintColor={dark ? color.onDarkMuted : color.muted}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export interface HeaderProps {
  title?: string;
  subtitle?: string;
  /** Shows a back chevron. Falls back to the tab root when there is no history. */
  back?: boolean;
  right?: React.ReactNode;
  dark?: boolean;
  /** No bottom hairline — for a header sitting directly on a coloured panel. */
  flush?: boolean;
}

/** The bar at the top of a pushed screen. */
export function Header({
  title,
  subtitle,
  back,
  right,
  dark,
  flush,
}: HeaderProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  return (
    <View
      style={{
        paddingTop: insets.top + (layout.wide ? space.lg : space.sm),
        // On a wide window the header sits inside the page's centred column,
        // where a white bar would stop short of the window's edges. It reads
        // as the page's title instead, on the page's own ground.
        backgroundColor: dark ? color.dark : layout.wide ? 'transparent' : color.surface,
        borderBottomWidth: flush || (layout.wide && !dark) ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: dark ? color.darkLine : color.border,
      }}
    >
      <View style={styles.header}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={styles.backButton}
          >
            <Icon name="chevron-left" size={22} color={dark ? color.onDark : color.ink} />
          </Pressable>
        ) : null}
        <View style={styles.headerText}>
          {title ? (
            <Text variant="h3" tone={dark ? 'onDark' : 'ink'} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text variant="small" tone={dark ? 'onDarkMuted' : 'muted'} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ?? null}
      </View>
    </View>
  );
}

/** A sticky bar pinned above the safe area — the confirm-order and publish CTAs. */
export function StickyFooter({
  children,
  dark,
}: {
  children: React.ReactNode;
  dark?: boolean;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  return (
    <View
      style={[
        styles.footer,
        {
          paddingBottom: insets.bottom + space.md,
          backgroundColor: dark ? color.dark : color.surface,
          borderTopColor: dark ? color.darkLine : color.border,
        },
      ]}
    >
      {/* A call to action as wide as a monitor reads as a banner, not a button. */}
      <View style={pageColumn(layout.wide)}>{children}</View>
    </View>
  );
}

export function Loading({ dark }: { dark?: boolean }): React.ReactElement {
  return (
    <View style={styles.centred}>
      <ActivityIndicator color={dark ? color.onDarkMuted : color.primary} />
    </View>
  );
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps): React.ReactElement {
  return (
    <View style={styles.empty}>
      {icon ? <View style={styles.emptyIcon}>{icon}</View> : null}
      <Text variant="h3" center>
        {title}
      </Text>
      {body ? (
        <Text variant="small" tone="muted" center style={styles.emptyBody}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/**
 * What a screen shows when its data could not be loaded.
 *
 * Always offers a retry: on a mobile network the overwhelmingly likely cause is
 * a dropped connection, and a dead end there would be the app's fault, not the
 * seller's.
 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.ReactElement {
  return (
    <View style={styles.empty}>
      <Text variant="h3" center>
        Something went wrong
      </Text>
      <Text variant="small" tone="muted" center style={styles.emptyBody}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable onPress={onRetry} style={styles.retry} accessibilityRole="button">
          <Text variant="smallMedium" tone="primary">
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Section heading — "NEEDS YOUR ACTION", "RESERVE RELEASES". */
export function SectionLabel({
  children,
  style,
}: {
  children: string;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <Text variant="eyebrow" tone="faint" style={[styles.sectionLabel, style]}>
      {children.toUpperCase()}
    </Text>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  backButton: { padding: 2 },
  headerText: { flex: 1 },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  centred: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  empty: { paddingVertical: 56, paddingHorizontal: space.xxl, alignItems: 'center' },
  emptyIcon: { marginBottom: space.lg, opacity: 0.7 },
  emptyBody: { marginTop: space.sm },
  emptyAction: { marginTop: space.xl, alignSelf: 'stretch' },
  retry: { marginTop: space.lg, paddingVertical: space.sm, paddingHorizontal: space.lg },
  sectionLabel: { marginBottom: space.md },
});
