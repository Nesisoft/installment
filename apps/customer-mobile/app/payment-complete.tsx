import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Loading, Screen, Text } from '../src/components';
import { safeReturnPath } from '../src/lib/payment-return';
import { space } from '../src/theme/tokens';

/**
 * Where Paystack sends a shopper back after paying.
 *
 * On a phone nobody sees this: the payment page opens in an auth session that
 * catches the `ejua://payment-complete` redirect itself. On the web it is a
 * real page, reached one of two ways:
 *
 * - **In the popup** checkout opened. Handing the URL to the opener closes the
 *   popup and returns the shopper to checkout, which moves on as it does on a
 *   phone.
 * - **In the main tab**, when the popup was blocked and checkout sent the whole
 *   tab to Paystack. Then this page sends the shopper on to `next`, usually the
 *   order's confirmation, which polls until the webhook has settled it.
 */
export default function PaymentComplete(): React.ReactElement {
  const { next } = useLocalSearchParams<{ next?: string | string[] }>();

  useEffect(() => {
    if (Platform.OS === 'web' && WebBrowser.maybeCompleteAuthSession().type === 'success') {
      return; // the opener closes this window
    }
    router.replace(safeReturnPath(next) as never);
  }, [next]);

  return (
    <Screen scroll={false}>
      <View style={styles.centre}>
        <Loading />
        <Text variant="small" tone="muted" center>
          Finishing your payment…
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
});
