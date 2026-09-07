import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Text';
import { color, radius, space, shadow } from '../theme/tokens';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Under the title, in muted type — which product, which order. */
  subtitle?: string;
  children: React.ReactNode;
  /** Pinned below the scrolling body: the save button and its "Done". */
  footer?: React.ReactNode;
}

/**
 * The bottom sheet the canvas draws for restocking.
 *
 * A real `Modal` rather than an absolutely-positioned overlay inside the
 * screen. Two reasons, and the second is why the first is not enough: a
 * `position: absolute` child of a `ScrollView` scrolls with its content on
 * Android, and only a Modal takes the hardware back button — a sheet a seller
 * cannot dismiss with Back is a sheet they will force-quit the app to escape.
 *
 * The scrim closes it, but the sheet body stops the press: a tap that lands on
 * the stepper must not also count as a tap on the scrim behind it, which is the
 * nested-Pressable trap the order card hit.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: SheetProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={styles.scrim}
      >
        {/* `onStartShouldSetResponder` rather than an onPress that does
            nothing: the latter still swallows the child's own touches on iOS. */}
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.grabber} />
          <Text variant="h2">{title}</Text>
          {subtitle ? (
            <Text variant="small" tone="muted" style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: color.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    // Capped so a long variant list scrolls inside the sheet instead of pushing
    // the save button off the bottom of the screen.
    maxHeight: '86%',
    ...shadow.raised,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.border,
    alignSelf: 'center',
    marginBottom: space.lg,
  },
  subtitle: { marginTop: space.xs },
  body: { marginTop: space.lg },
  bodyContent: { gap: space.md },
  footer: { paddingTop: space.lg, gap: space.sm },
});
