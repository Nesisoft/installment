import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Header,
  Line,
  Loading,
  Note,
  Pill,
  Screen,
  SectionLabel,
  Sheet,
  StickyFooter,
  Text,
  Total,
} from '../../src/components';
import { useDecideReturn, useReturn } from '../../src/features/merchant';
import { shortDate } from '../../src/lib/dates';
import { ghs, phoneLocal, pluralise } from '../../src/lib/format';
import { color, radius, space } from '../../src/theme/tokens';
import { RETURN_PILL } from './index';

/**
 * One return, and the decision.
 *
 * The money block is the reason this screen exists rather than a pair of
 * buttons on the queue. Accepting is not a status change: it reverses the sale
 * in the ledger, takes the seller's net back off their payable balance,
 * reverses Ejua's commission, puts the goods on the shelf and raises the
 * buyer's refund — one transaction, and irreversible. A seller pressing that
 * should have read what it costs first, in cedis, on the same screen.
 */
export default function ReturnScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const request = useReturn(id);
  const decide = useDecideReturn(id);
  const [confirming, setConfirming] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void request.refetch();
  }, [request]);

  if (request.isPending) {
    return (
      <Screen>
        <Header back title="Return" />
        <Loading />
      </Screen>
    );
  }

  if (request.error || !request.data) {
    return (
      <Screen>
        <Header back title="Return" />
        <ErrorState
          message={apiErrorMessage(request.error, 'Could not load this return.')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  const r = request.data;
  const open = r.status === 'requested';
  const pill = RETURN_PILL[r.status] ?? { label: r.status.toUpperCase(), tone: 'neutral' as const };

  function approve(): void {
    setError(null);
    decide.mutate(
      { approve: true },
      {
        onSuccess: () => setConfirming(false),
        onError: (err) => {
          setConfirming(false);
          setError(apiErrorMessage(err, 'That could not be accepted.'));
        },
      },
    );
  }

  function refuse(): void {
    setError(null);
    if (!note.trim()) return;
    decide.mutate(
      { approve: false, note: note.trim() },
      {
        onSuccess: () => setRefusing(false),
        onError: (err) => {
          setRefusing(false);
          setError(apiErrorMessage(err, 'That could not be refused.'));
        },
      },
    );
  }

  return (
    <>
      <Screen footerHeight={open ? 112 : 0} refreshing={request.isFetching} onRefresh={refresh}>
        <Header
          back
          title={r.orderNumber}
          subtitle={[r.buyerName, r.itemSummary].filter(Boolean).join(' · ') || undefined}
          right={<Pill label={pill.label} tone={pill.tone} />}
        />

        <View style={styles.body}>
          <Card style={styles.gap}>
            <Text variant="eyebrow" tone="faint">
              {`ASKED FOR ${shortDate(r.requestedAt).toUpperCase()}`}
            </Text>
            <Text variant="body" style={styles.reason}>
              {`“${r.reason}”`}
            </Text>
            {r.buyerName || r.buyerPhone ? (
              <Text variant="tiny" tone="faint">
                {[r.buyerName, r.buyerPhone ? phoneLocal(r.buyerPhone) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
          </Card>

          <View>
            <SectionLabel>{open ? 'What accepting costs' : 'What it cost'}</SectionLabel>
            <Card>
              <Line label="Order" value={ghs(r.orderTotalPesewas)} />
              <Line label="Ejua fee reversed" value={`+${ghs(r.commissionReversedPesewas)}`} />
              <Line
                label="Taken off your balance"
                value={`−${ghs(r.merchantLosesPesewas)}`}
                deduction
              />
              <Total
                label="Refunded to the buyer"
                sub="Ejua pays this; it is not taken from your MoMo."
                value={ghs(r.refundPesewas)}
              />
            </Card>
          </View>

          <View>
            <SectionLabel>{`What is coming back · ${pluralise(r.items.length, 'line')}`}</SectionLabel>
            <Card bare style={styles.rows}>
              {r.items.length === 0 ? (
                <Text variant="small" tone="muted" style={styles.gone}>
                  The order&apos;s lines are no longer on file. The refund amount was fixed when the
                  buyer asked, so the decision is still about a known figure.
                </Text>
              ) : (
                r.items.map((item, i) => (
                  <View key={`${item.title}-${i}`} style={[styles.item, i > 0 && styles.divided]}>
                    <View style={styles.itemText}>
                      <Text variant="smallMedium" numberOfLines={2}>
                        {item.title}
                      </Text>
                      <Text variant="tiny" tone="faint">
                        {`${item.quantity} × ${ghs(item.unitPricePesewas)}`}
                      </Text>
                    </View>
                    <Text variant="smallMedium">{ghs(item.unitPricePesewas * item.quantity)}</Text>
                  </View>
                ))
              )}
            </Card>
          </View>

          {!open ? (
            <Note
              eyebrow={r.status === 'approved' ? 'You accepted this' : 'You refused this'}
              tone={r.status === 'approved' ? 'primary' : 'neutral'}
            >
              {r.status === 'approved'
                ? `Accepted ${r.decidedAt ? shortDate(r.decidedAt) : ''}. ${ghs(r.refundPesewas)} is owed to the buyer and the goods went back on your shelf. The order now reads as returned.`.trim()
                : `Refused ${r.decidedAt ? shortDate(r.decidedAt) : ''}. The buyer was shown: “${r.decisionNote ?? '—'}”`.trim()}
            </Note>
          ) : (
            <Note eyebrow="Before you decide">
              {/* Both halves are true and neither is obvious: `approve` is
                  guarded by ReturnAlreadyDecidedError, and the refund is Ejua's
                  obligation booked to `refund_payable`, not a debit of the
                  seller's wallet. */}
              A decision cannot be undone, so take the time. Accepting refunds the buyer through
              Ejua — no money is taken out of your MoMo — and instead reduces what Ejua owes you on
              the next payout run.
            </Note>
          )}

          {error ? (
            <Note eyebrow="Not decided" tone="warn">
              {error}
            </Note>
          ) : null}

          <Button
            label="Open the order"
            variant="outline"
            onPress={() => router.push(`/orders/${r.orderId}`)}
          />
        </View>
      </Screen>

      {open ? (
        <StickyFooter>
          <Button
            label="Accept the return"
            sublabel={`Refund ${ghs(r.refundPesewas)} · ${ghs(r.merchantLosesPesewas)} off your balance`}
            disabled={decide.isPending}
            onPress={() => setConfirming(true)}
          />
          <Button
            label="Refuse it"
            variant="outline"
            compact
            disabled={decide.isPending}
            onPress={() => {
              setNote('');
              setRefusing(true);
            }}
            style={styles.refuse}
          />
        </StickyFooter>
      ) : null}

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Accept this return?"
        subtitle={r.itemSummary ?? r.orderNumber}
        footer={
          <>
            <Button
              label={decide.isPending ? 'Accepting…' : `Yes — refund ${ghs(r.refundPesewas)}`}
              loading={decide.isPending}
              disabled={decide.isPending}
              onPress={approve}
            />
            <Button
              label="Not yet"
              variant="outline"
              disabled={decide.isPending}
              onPress={() => setConfirming(false)}
            />
          </>
        }
      >
        <Text variant="small" tone="muted">
          {`This cannot be undone. ${ghs(r.refundPesewas)} goes back to the buyer, ${ghs(r.merchantLosesPesewas)} comes off what Ejua owes you, and the goods go back on sale straight away.`}
        </Text>
      </Sheet>

      <Sheet
        open={refusing}
        onClose={() => setRefusing(false)}
        title="Refuse this return"
        subtitle={r.itemSummary ?? r.orderNumber}
        footer={
          <>
            <Button
              label={decide.isPending ? 'Sending…' : 'Refuse it'}
              loading={decide.isPending}
              disabled={decide.isPending || !note.trim()}
              onPress={refuse}
            />
            <Button
              label="Cancel"
              variant="outline"
              disabled={decide.isPending}
              onPress={() => setRefusing(false)}
            />
          </>
        }
      >
        <Field
          label="WHY"
          value={note}
          onChangeText={setNote}
          placeholder="Worn, and outside the seven days on the listing."
          multiline
          maxLength={1000}
          style={styles.noteField}
          // A CHECK constraint requires it, and so does the buyer: a refusal
          // with no reason is not something anyone can act on.
          hint="The buyer is shown exactly what you write here. Required."
        />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  gap: { gap: space.sm },
  reason: { lineHeight: 22 },

  rows: { paddingHorizontal: space.lg },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  itemText: { flex: 1 },
  gone: { paddingVertical: space.lg },

  refuse: { marginTop: space.sm },
  noteField: { minHeight: 88, textAlignVertical: 'top', borderRadius: radius.md },
});
