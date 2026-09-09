import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  Header,
  Loading,
  Screen,
  SectionLabel,
  StickyFooter,
  Text,
  TextArea,
} from '../../src/components';
import { useOrder } from '../../src/features/shop';
import { useOpenReturnFor, useRequestReturn } from '../../src/features/returns';
import { REQUEST_RETURN_REASON_MAX } from '../../src/features/types';
import { ghsExact } from '../../src/lib/format';
import { longDate, parseApiDate, shortDate } from '../../src/lib/dates';
import { color, radius, space } from '../../src/theme/tokens';

/**
 * Four openers, not a dropdown.
 *
 * The seller decides on the reason, and "wrong size" and "arrived with the
 * screen cracked" are different decisions — which is why `requestReturnSchema`
 * takes free text and refuses a fixed list. These fill the box rather than
 * replace it: a chip on its own is a valid reason and the buyer can send it,
 * but the cursor lands after it and the hint asks for the rest.
 */
const OPENERS = ['Wrong size', 'Not as described', 'Arrived damaged', 'Changed my mind'] as const;

/**
 * Asking to send an order back.
 *
 * The whole order, because that is what the record is: `order_returns` is
 * per-order by design — `order_items` has no status column, so returning one
 * shirt of three would leave `orders.status = 'returned'` lying about the other
 * two.
 *
 * The screen refuses to submit what the server would refuse. Three of the four
 * eligibility rules are on the order the app already holds; the fourth — an
 * open request on this order — is not on the order at all, so it comes off the
 * returns list. Without that check the button is offered to a buyer who has
 * already asked, and they take a 409 for doing what the screen invited.
 */
export default function RequestReturnScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ order?: string }>();
  const orderId = params.order ?? '';
  const order = useOrder(orderId);
  const openReturn = useOpenReturnFor(orderId, Boolean(orderId));
  const request = useRequestReturn(orderId);

  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (order.isPending) {
    return (
      <Screen>
        <Header title="Send it back" back />
        <Loading />
      </Screen>
    );
  }

  if (order.error || !order.data) {
    return (
      <Screen>
        <Header title="Send it back" back />
        <ErrorState
          message={apiErrorMessage(order.error, 'We could not open that order.')}
          onRetry={() => void order.refetch()}
        />
      </Screen>
    );
  }

  const data = order.data;
  const windowEnds = parseApiDate(data.return_window_ends_at);
  // Null before delivery, and that is NOT "no window" — a paid or shipped
  // order is returnable and simply has not started its clock. Only a window
  // that exists and has passed closes the door.
  const windowClosed = windowEnds !== null && windowEnds.getTime() < Date.now();
  const wrongPaymentType = data.payment_type !== 'full';
  const wrongStatus = !['paid', 'shipped', 'delivered'].includes(data.status);

  const blocker = wrongPaymentType
    ? 'Instalment orders are unwound with their payment plan, not through this form. Message support and they will sort it out with you.'
    : wrongStatus
      ? `This order is "${data.status.replace(/_/g, ' ')}", so there is nothing to send back yet.`
      : windowClosed
        ? `The return window closed on ${longDate(data.return_window_ends_at)}.`
        : openReturn
          ? 'You have already asked to send this order back. The seller is looking at it.'
          : null;

  async function submit(): Promise<void> {
    setError(null);
    try {
      await request.mutateAsync(reason.trim());
      // `replace`, not `push`: going back to a form for a request that now
      // exists would only produce a 409.
      router.replace('/returns');
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not send that request.'));
    }
  }

  return (
    <Screen footerHeight={blocker ? 0 : 96}>
      <Header
        title="Send it back"
        subtitle={`${data.order_number}${data.delivered_at ? ` · delivered ${shortDate(data.delivered_at)}` : ''}`}
        back
      />

      <View style={styles.body}>
        <SectionLabel>What goes back</SectionLabel>
        <Card>
          {data.items.map((item) => (
            <View key={item.id} style={styles.line}>
              <View style={styles.lineText}>
                <Text variant="bodyMedium" numberOfLines={2}>
                  {item.title}
                </Text>
                <Text variant="tiny" tone="muted">
                  {`${item.sku} · ${item.quantity}`}
                </Text>
              </View>
              <Text variant="smallMedium">{ghsExact(item.line_total_pesewas)}</Text>
            </View>
          ))}
          <View style={styles.total}>
            <Text variant="small" tone="muted" style={styles.totalLabel}>
              Back to you if the seller agrees
            </Text>
            <Text variant="price">{ghsExact(data.total_pesewas)}</Text>
          </View>
          <Text variant="tiny" tone="faint" style={styles.note}>
            The whole order, not one item — Ejua sends an order back at a time, so everything on it
            travels together.
          </Text>
        </Card>

        {blocker ? (
          <Card>
            <Text variant="bodyMedium">Not this one</Text>
            <Text variant="small" tone="muted" style={styles.blocker}>
              {blocker}
            </Text>
            {openReturn ? (
              <Button
                label="See my returns"
                variant="outline"
                onPress={() => router.replace('/returns')}
                style={styles.blockerCta}
              />
            ) : null}
          </Card>
        ) : (
          <>
            <SectionLabel>Why</SectionLabel>
            <View style={styles.chips}>
              {OPENERS.map((opener) => (
                <Chip
                  key={opener}
                  label={opener}
                  selected={reason.startsWith(opener)}
                  onPress={() => setReason((r) => (r.startsWith(opener) ? r : `${opener} — `))}
                />
              ))}
            </View>
            <TextArea
              value={reason}
              onChangeText={setReason}
              maxLength={REQUEST_RETURN_REASON_MAX}
              placeholder="Tell the seller what went wrong…"
              hint="In your own words. The seller reads this and decides, so a line about what happened is worth more than the label alone."
              accessibilityLabel="Why you are sending it back"
            />

            <View style={styles.next}>
              <Text variant="eyebrow" tone="faint">
                WHAT HAPPENS NEXT
              </Text>
              <Text variant="small" tone="muted" style={styles.nextBody}>
                {`Asking changes nothing yet — the order stands until the seller answers. If they agree, Ejua refunds you the ${ghsExact(data.total_pesewas)} above. That amount is fixed the moment you ask, so it cannot move while they think about it.`}
              </Text>
            </View>

            {error ? (
              <Text variant="tiny" tone="accent">
                {error}
              </Text>
            ) : null}
          </>
        )}
      </View>

      {blocker ? null : (
        <StickyFooter>
          <Button
            label={request.isPending ? 'Sending…' : 'Ask to send it back'}
            sublabel="The seller usually answers within a day"
            loading={request.isPending}
            disabled={reason.trim().length === 0 || request.isPending}
            onPress={() => void submit()}
          />
        </StickyFooter>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.md, paddingTop: space.md },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  lineText: { flex: 1, gap: 2 },
  total: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderTopWidth: 1,
    borderTopColor: color.borderSoft,
    marginTop: space.sm,
    paddingTop: space.md,
  },
  totalLabel: { flex: 1 },
  note: { marginTop: space.md, lineHeight: 16 },
  blocker: { marginTop: space.sm, lineHeight: 20 },
  blockerCta: { marginTop: space.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  next: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  nextBody: { lineHeight: 20 },
});
