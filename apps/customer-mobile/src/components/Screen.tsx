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
import { color, radius, space, TAB_BAR_HEIGHT } from '../theme/tokens';

/**
 * How close to the bottom counts as the end.
 *
 * Roughly one screen: the next page starts loading while the reader still has
 * something to look at, which on a slow connection is the difference between
 * paging and waiting.
 */
const END_THRESHOLD = 600;

export interface ScreenProps {
  children: React.ReactNode;
  /** Dark screens (onboarding, confirmation, account header) paint their own ground. */
  dark?: boolean;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Leaves room for the tab bar; set on the five tab screens. */
  tabBar?: boolean;
  /** Leaves room for a sticky footer of this height. */
  footerHeight?: number;
  /**
   * Called once per approach to the bottom, for a list that pages.
   *
   * On a ScrollView rather than a FlatList because that is what these screens
   * are: Browse's grid sits under a sticky filter bar and a chip rail in the
   * same scroll, and a FlatList would mean rebuilding all three around a
   * `ListHeaderComponent`. The guard below is what a FlatList would give for
   * free — without it every scroll event inside the threshold fires again.
   */
  onEndReached?: () => void;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

export function Screen({
  children,
  dark,
  scroll = true,
  refreshing,
  onRefresh,
  tabBar,
  footerHeight = 0,
  onEndReached,
  style,
  contentStyle,
}: ScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  // Latched while the reader is inside the threshold and released when they
  // scroll back out, so one approach to the bottom is one call however many
  // scroll events it takes. The caller is still expected to ignore the call
  // when it has nothing more to fetch.
  const armed = React.useRef(true);
  const background = dark ? color.dark : color.canvas;
  const bottomPad =
    (tabBar ? TAB_BAR_HEIGHT + insets.bottom : insets.bottom) + footerHeight + space.lg;

  if (!scroll) {
    return <View style={[styles.flex, { backgroundColor: background }, style]}>{children}</View>;
  }

  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: background }, style]}
      contentContainerStyle={[{ paddingBottom: bottomPad }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={onEndReached ? 96 : undefined}
      onScroll={
        onEndReached
          ? (event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
              if (fromBottom <= END_THRESHOLD) {
                if (armed.current) {
                  armed.current = false;
                  onEndReached();
                }
              } else {
                armed.current = true;
              }
            }
          : undefined
      }
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
  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + space.sm,
          backgroundColor: dark ? color.dark : color.surface,
          borderBottomWidth: flush ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: dark ? color.darkLine : color.border,
        },
      ]}
    >
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
  );
}

/** A sticky bar pinned above the safe area — the checkout and product CTAs. */
export function StickyFooter({
  children,
  dark,
}: {
  children: React.ReactNode;
  dark?: boolean;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
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
      {children}
    </View>
  );
}

export function Loading({ dark }: { dark?: boolean }): React.ReactElement {
  return (
    <View style={styles.centred}>
      <ActivityIndicator color={dark ? color.onDarkMuted : color.accent} />
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
 * customer's.
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
          <Text variant="smallMedium" tone="accent">
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Section heading — "PAYMENT SCHEDULE", "1 · HOW YOU GET IT". */
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
  listFooter: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  listMore: {
    paddingVertical: space.sm,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunk,
  },
});

export interface ListFooterProps {
  /** Whether another page exists. */
  hasMore: boolean;
  /** Whether one is on its way. */
  loading: boolean;
  onLoadMore: () => void;
  /** How many are on screen now. */
  shown: number;
  /** How many there are altogether, or null while that is not known. */
  total: number | null;
  /** Word for one item — "item", "result", "product". */
  noun?: string;
}

/**
 * The bottom of a list that pages.
 *
 * The button is not a fallback for the scroll trigger, it is the real control:
 * scrolling to load is invisible to a screen reader and unreliable on a slow
 * connection, and a shopper who wants the next thirty should be able to ask
 * for them. The scroll trigger is the convenience layered on top.
 *
 * The last line is a count that has to be TRUE. Browse used to print the real
 * total over a grid that could only ever hold thirty, which is the specific
 * lie this whole change exists to stop telling.
 */
export function ListFooter({
  hasMore,
  loading,
  onLoadMore,
  shown,
  total,
  noun = 'item',
}: ListFooterProps): React.ReactElement | null {
  if (shown === 0) return null;

  if (loading) {
    return (
      <View style={styles.listFooter}>
        <ActivityIndicator color={color.muted} />
        <Text variant="tiny" tone="faint">
          Loading more…
        </Text>
      </View>
    );
  }

  if (hasMore) {
    return (
      <View style={styles.listFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            total === null ? 'Show more' : `Show more, ${shown} of ${total} so far`
          }
          onPress={onLoadMore}
          style={styles.listMore}
        >
          <Text variant="smallMedium" tone="accent">
            Show more
          </Text>
        </Pressable>
        {total === null ? null : (
          <Text variant="tiny" tone="faint">
            {`${shown} of ${total}`}
          </Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.listFooter}>
      <Text variant="tiny" tone="faint">
        {total === null || total !== shown
          ? `That is all ${shown}`
          : `That is all ${shown} ${shown === 1 ? noun : `${noun}s`}`}
      </Text>
    </View>
  );
}
