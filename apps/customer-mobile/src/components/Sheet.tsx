import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, fillParent, radius, space } from '../theme/tokens';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  dark?: boolean;
  /**
   * Whether tapping the scrim or the hardware back button dismisses it.
   * The BNPL approval sheet sets this false while a decision is in flight —
   * a customer who dismisses mid-scoring would be left not knowing whether
   * they had just opened a credit line.
   */
  dismissable?: boolean;
}

/** The bottom sheet used for filters and the BNPL approval flow. */
export function Sheet({
  visible,
  onClose,
  children,
  dark,
  dismissable = true,
}: SheetProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={dismissable ? onClose : undefined}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.scrim}
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={dismissable ? onClose : undefined}
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + space.lg },
            dark ? styles.dark : styles.light,
          ]}
        >
          <View style={[styles.grabber, dark ? styles.grabberDark : styles.grabberLight]} />
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...fillParent, backgroundColor: color.scrim },
  sheet: {
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    maxHeight: '92%',
  },
  light: { backgroundColor: color.surface },
  dark: { backgroundColor: color.dark },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginBottom: space.lg,
  },
  grabberLight: { backgroundColor: color.borderStrong },
  grabberDark: { backgroundColor: color.darkBorder },
});
