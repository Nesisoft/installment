import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Header,
  Icon,
  Loading,
  Pill,
  Screen,
  StickyFooter,
  Text,
} from '../../src/components';
import { useAddresses, useDeleteAddress, useSetDefaultAddress } from '../../src/features/shop';
import type { Address } from '../../src/features/types';
import { phoneDisplay } from '../../src/lib/format';
import { color, radius, space } from '../../src/theme/tokens';

/**
 * Where a shopper's parcels go.
 *
 * Five of the six address routes had no caller in any client: only the list was
 * read, by checkout, and everything else — edit, set default, delete — existed
 * and was unreachable. The Account row labelled "Delivery addresses" pushed
 * `/checkout`, which is a strange place to be sent to look at an address book.
 *
 * Editing and deleting are safe to offer as of #87. Before that an edit
 * rewrote the delivery address of every past order pointing at the row, and a
 * delete blanked it — the order carries its own copy now.
 */
export default function AddressBookScreen(): React.ReactElement {
  const addresses = useAddresses();
  const setDefault = useSetDefaultAddress();
  const remove = useDeleteAddress();
  const [error, setError] = useState<string | null>(null);

  const rows = addresses.data ?? [];
  const busy = setDefault.isPending || remove.isPending;

  return (
    <Screen
      footerHeight={92}
      refreshing={addresses.isRefetching}
      onRefresh={() => void addresses.refetch()}
    >
      <Header title="Delivery addresses" back />

      <View style={styles.body}>
        {error ? (
          <Text variant="tiny" tone="accent">
            {error}
          </Text>
        ) : null}

        {addresses.isPending ? (
          <Loading />
        ) : addresses.error ? (
          <ErrorState
            message={apiErrorMessage(addresses.error, 'We could not load your addresses.')}
            onRetry={() => void addresses.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Icon name="pin" size={26} color={color.mutedSoft} />}
            title="No addresses saved"
            body="Add one and it will be waiting at checkout. You can keep several and pick one each time."
          />
        ) : (
          rows.map((address) => (
            <AddressCard
              key={address.id}
              address={address}
              busy={busy}
              onEdit={() => router.push(`/addresses/edit?id=${address.id}`)}
              onMakeDefault={() => {
                setError(null);
                setDefault.mutate(address.id, {
                  onError: (err) =>
                    setError(apiErrorMessage(err, 'We could not change your default address.')),
                });
              }}
              onDelete={() => confirmDelete(address)}
            />
          ))
        )}

        {/* The canvas's own copy, and the reason the field is on the form. The
            column has existed since the addresses table did and no client has
            ever offered it. */}
        <View style={styles.note}>
          <Text variant="eyebrow" tone="faint">
            GHANAPOSTGPS
          </Text>
          <Text variant="tiny" tone="soft" style={styles.noteBody}>
            The five-and-four code from the GhanaPostGPS app — GA-183-4471. It is how a rider
            actually finds a door here, and it is the one field that turns “behind the blue kiosk”
            into an address. Optional, but a delivery with one arrives sooner.
          </Text>
        </View>
      </View>

      <StickyFooter>
        <Button
          label="Add an address"
          variant="outline"
          onPress={() => router.push('/addresses/edit')}
        />
      </StickyFooter>
    </Screen>
  );

  function confirmDelete(address: Address): void {
    Alert.alert(
      'Remove this address?',
      address.is_default
        ? 'It is your default. Another saved address will take over, and orders already placed keep the address they were sent to.'
        : 'Orders already placed keep the address they were sent to.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setError(null);
            remove.mutate(address.id, {
              onError: (err) => setError(apiErrorMessage(err, 'We could not remove that address.')),
            });
          },
        },
      ],
    );
  }
}

function AddressCard({
  address,
  busy,
  onEdit,
  onMakeDefault,
  onDelete,
}: {
  address: Address;
  busy: boolean;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}): React.ReactElement {
  /**
   * The address as four lines.
   *
   * The canvas draws five — phone, a street line, a neighbourhood-and-city
   * line, then a landmark — but the table has four usable text columns and no
   * street column at all. Rather than invent one, `area` carries whatever the
   * shopper wrote for the street or the neighbourhood and gets its own line.
   */
  const lines = [
    phoneDisplay(address.phone),
    address.area,
    `${address.city} · ${address.region}`,
    address.landmark,
  ].filter((line): line is string => Boolean(line));

  return (
    <Card style={address.is_default ? styles.cardDefault : undefined}>
      <View style={styles.head}>
        <Text variant="bodyMedium" style={styles.headName} numberOfLines={1}>
          {address.recipient}
        </Text>
        {address.is_default ? <Pill label="DEFAULT" tone="accent" /> : null}
      </View>

      <View style={styles.lines}>
        {lines.map((line) => (
          <Text key={line} variant="small" tone="muted" style={styles.line}>
            {line}
          </Text>
        ))}
      </View>

      {address.ghanapost_gps ? (
        <View style={styles.gps}>
          <Icon name="pin" size={14} color={color.success} />
          <Text variant="tiny" tone="success">
            {address.ghanapost_gps}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onEdit} hitSlop={8}>
          <Text variant="tiny" tone="accent">
            Edit
          </Text>
        </Pressable>
        {address.is_default ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Make ${address.recipient}'s address the default`}
            disabled={busy}
            onPress={onMakeDefault}
            hitSlop={8}
          >
            <Text variant="tiny" tone="soft">
              Make default
            </Text>
          </Pressable>
        )}
        <View style={styles.spacer} />
        {/* Not on the artboard, which draws only Edit and Make default — but
            DELETE has always existed and been unreachable, which is the whole
            class of thing this audit is closing. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${address.recipient}'s address`}
          disabled={busy}
          onPress={onDelete}
          hitSlop={8}
        >
          <Text variant="tiny" tone="faint">
            Remove
          </Text>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.md, paddingTop: space.md },
  cardDefault: { borderColor: color.border },

  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headName: { flex: 1 },

  lines: { marginTop: space.sm, gap: 1 },
  line: { lineHeight: 19 },

  gps: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderTopWidth: 1,
    borderTopColor: color.borderSoft,
    marginTop: space.md,
    paddingTop: 11,
  },
  spacer: { flex: 1 },

  note: {
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  noteBody: { lineHeight: 17 },
});
