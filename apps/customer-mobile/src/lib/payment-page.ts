import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

/** The route Paystack sends a shopper back to. See `app/payment-complete.tsx`. */
const RETURN_ROUTE = '/payment-complete';

/**
 * The URL to give Paystack as `callback_url`: back to this app, carrying where
 * to go next. On a phone that is the `ejua://` scheme, which the auth session
 * below intercepts; on the web it is this site's own `/payment-complete`.
 */
export function paymentReturnUrl(next: string): string {
  return Linking.createURL(RETURN_ROUTE, { queryParams: { next } });
}

/**
 * Opens a Paystack payment page and waits for the shopper to come back.
 *
 * Returns `'returned'` once they are back on this screen, whether they paid or
 * closed the page: the payment settles by webhook either way, and the next
 * screen polls for it. Returns `'left'` when this page has navigated away to
 * Paystack instead, and the shopper will come back through `payment-complete`.
 *
 * That second case is the web only. There the page opens in a popup, which a
 * browser may block — mobile browsers often do when the click and the
 * `window.open` are separated by a network call, as they are here. Rather than
 * leave the shopper with a button that does nothing, the whole tab goes to
 * Paystack.
 */
export async function openPaymentPage(url: string): Promise<'returned' | 'left'> {
  try {
    // The bare route, not the URL with `next`: on a phone the auth session
    // matches the returning URL by prefix, and on the web query strings are
    // ignored when the popup is matched to its opener.
    await WebBrowser.openAuthSessionAsync(url, Linking.createURL(RETURN_ROUTE));
    return 'returned';
  } catch (err) {
    if (Platform.OS === 'web' && (err as { code?: string }).code === 'ERR_WEB_BROWSER_BLOCKED') {
      window.location.assign(url);
      return 'left';
    }
    throw err;
  }
}
