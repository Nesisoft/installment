import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Header, Screen } from './Screen';
import { color, radius, space } from '../theme/tokens';

export interface ComingNextProps {
  title: string;
  icon: IconName;
  /** What this tab will do, in the seller's terms — not "coming soon". */
  body: string;
  /** Where the same job can be done today, if anywhere. */
  meanwhile?: string;
  /** Anything the tab must still offer while the rest of it is unbuilt. */
  footer?: React.ReactNode;
}

/**
 * A tab that exists in the bar but is not built.
 *
 * Says so, rather than rendering an empty list. An unbuilt Products tab showing
 * "No products" would tell a seller with forty listings that their catalogue
 * had vanished — the worst possible lie for this app to tell — so the screen
 * names itself as unfinished and points at where the job can be done today.
 */
export function ComingNext({
  title,
  icon,
  body,
  meanwhile,
  footer,
}: ComingNextProps): React.ReactElement {
  return (
    <Screen tabBar>
      <Header title={title} />
      <View style={styles.body}>
        <View style={styles.badge}>
          <Icon name={icon} size={26} color={color.muted} />
        </View>
        <Text variant="h3" center style={styles.title}>
          Not in the app yet
        </Text>
        <Text variant="small" tone="muted" center style={styles.text}>
          {body}
        </Text>
        {meanwhile ? (
          <Text variant="tiny" tone="faint" center style={styles.text}>
            {meanwhile}
          </Text>
        ) : null}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: 64, paddingHorizontal: space.xxl, alignItems: 'center' },
  badge: {
    width: 60,
    height: 60,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: space.lg },
  text: { marginTop: space.sm, maxWidth: 320 },
  footer: { marginTop: space.xxxl, alignSelf: 'stretch' },
});
