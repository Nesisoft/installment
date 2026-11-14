import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { apiErrorMessage, useApi } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Header,
  Icon,
  Loading,
  Screen,
  SectionLabel,
  Text,
} from '../src/components';
import { useMerchantStatement } from '../src/features/merchant';
import { exportStatement, type StatementFormat } from '../src/lib/statement-export';
import {
  currentPeriod,
  hasNextPeriod,
  periodLabel,
  periodSlug,
  stepPeriod,
  type StatementPeriod,
} from '../src/lib/statement-period';
import { shortDate } from '../src/lib/dates';
import { color, radius, space } from '../src/theme/tokens';

/** What the two export buttons say where the seller is. */
const EXPORT_LABELS: Record<StatementFormat, string> =
  Platform.OS === 'web'
    ? { csv: 'Download CSV', html: 'Print or save as PDF' }
    : { csv: 'Share as CSV', html: 'Print or save as PDF' };

/**
 * The seller's monthly account statement.
 *
 * Every figure here is read from the ledger by the API, so it agrees to the
 * pesewa with the payouts screen and with the CSV an accountant opens. The
 * month steps back as far as the seller likes and stops at the current one.
 */
export default function StatementsScreen(): React.ReactElement {
  const api = useApi();
  const [period, setPeriod] = useState<StatementPeriod>(() => currentPeriod());
  const statement = useMerchantStatement(period);
  const [exporting, setExporting] = useState<StatementFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportAs(format: StatementFormat): Promise<void> {
    setExportError(null);
    setExporting(format);
    try {
      await exportStatement(
        api,
        {
          path: '/merchant/statement',
          params: { year: period.year, month: period.month },
          filename: `ejua-statement-${periodSlug(period)}`,
        },
        format,
      );
    } catch (err) {
      setExportError(apiErrorMessage(err, 'We could not prepare that file just now. Try again.'));
    } finally {
      setExporting(null);
    }
  }

  const data = statement.data;

  return (
    <Screen refreshing={statement.isRefetching} onRefresh={() => void statement.refetch()}>
      <Header title="Statements" subtitle="Your account, month by month" back />

      <View style={styles.body}>
        <View style={styles.stepper}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            hitSlop={10}
            onPress={() => setPeriod((p) => stepPeriod(p, -1))}
            style={styles.stepButton}
          >
            <Icon name="chevron-left" size={20} color={color.ink} />
          </Pressable>
          <Text variant="h3" style={styles.stepLabel}>
            {periodLabel(period)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            accessibilityState={{ disabled: !hasNextPeriod(period) }}
            disabled={!hasNextPeriod(period)}
            hitSlop={10}
            onPress={() => setPeriod((p) => stepPeriod(p, 1))}
            style={[styles.stepButton, !hasNextPeriod(period) && styles.stepOff]}
          >
            <Icon name="chevron-right" size={20} color={color.ink} />
          </Pressable>
        </View>

        {statement.isPending ? <Loading /> : null}
        {statement.isError ? (
          <ErrorState
            message={apiErrorMessage(statement.error, 'We could not load this statement.')}
            onRetry={() => void statement.refetch()}
          />
        ) : null}

        {data ? (
          <>
            <Card>
              <View style={styles.grid}>
                <Figure label="Opening balance" value={data.summary.openingBalance} />
                <Figure label="Closing balance" value={data.summary.closingBalance} strong />
                <Figure label="Credited" value={data.summary.totalCredited} />
                <Figure label="Debited" value={data.summary.totalDebited} />
                <Figure label="Reserve released" value={data.summary.reserveReleased} />
                <Figure label="Paid out" value={data.summary.paidOut} />
              </View>
            </Card>

            <View style={styles.actions}>
              <Button
                label={EXPORT_LABELS.csv}
                variant="outline"
                compact
                loading={exporting === 'csv'}
                disabled={exporting !== null}
                onPress={() => void exportAs('csv')}
                style={styles.action}
              />
              <Button
                label={EXPORT_LABELS.html}
                variant="outline"
                compact
                loading={exporting === 'html'}
                disabled={exporting !== null}
                onPress={() => void exportAs('html')}
                style={styles.action}
              />
            </View>
            {exportError ? (
              <Text variant="small" tone="accent">
                {exportError}
              </Text>
            ) : null}

            <View>
              <SectionLabel>{`Activity · ${data.lines.length}`}</SectionLabel>
              {data.lines.length === 0 ? (
                <Card>
                  <Text variant="small" tone="muted">
                    Nothing moved on your account in {periodLabel(period)}.
                  </Text>
                </Card>
              ) : (
                <Card bare>
                  {data.lines.map((line, i) => (
                    <View
                      key={`${line.transactionId}-${i}`}
                      style={[styles.line, i > 0 && styles.divided]}
                    >
                      <View style={styles.lineText}>
                        <Text variant="smallMedium" numberOfLines={2}>
                          {line.description}
                        </Text>
                        <Text variant="tiny" tone="faint">
                          {shortDate(line.date)}
                        </Text>
                      </View>
                      {/* A credit to the seller's payable is money to them. */}
                      <Text
                        variant="smallMedium"
                        tone={line.direction === 'credit' ? 'primary' : 'accent'}
                      >
                        {line.direction === 'credit' ? `+${line.amount}` : `−${line.amount}`}
                      </Text>
                    </View>
                  ))}
                </Card>
              )}
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

function Figure({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.figure}>
      <Text variant="eyebrow" tone="faint">
        {label.toUpperCase()}
      </Text>
      <Text variant={strong ? 'h3' : 'bodyMedium'}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  stepButton: { padding: space.sm, borderRadius: radius.pill },
  stepOff: { opacity: 0.3 },
  stepLabel: { flex: 1, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.lg },
  figure: { width: '50%', gap: 4, paddingRight: space.md },
  actions: { flexDirection: 'row', gap: space.md },
  action: { flex: 1 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  lineText: { flex: 1, gap: 2 },
});
