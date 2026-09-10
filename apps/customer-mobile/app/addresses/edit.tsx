import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiErrorMessage } from '@installment/mobile-kit';
import { GHANA_REGIONS } from '@installment/api-types';
import {
  Button,
  Chip,
  ErrorState,
  Field,
  Header,
  Loading,
  Screen,
  SectionLabel,
  StickyFooter,
  Text,
} from '../../src/components';
import { useAddresses, useCreateAddress, useUpdateAddress } from '../../src/features/shop';
import { DEFAULT_REGION } from '../../src/lib/config';
import { color, radius, space } from '../../src/theme/tokens';

/**
 * Adding or correcting an address.
 *
 * The canvas has an address book but never drew this screen — "Add an address"
 * and "Edit" lead nowhere on the artboard — so the form is derived from
 * `createAddressSchema`: four required fields, three optional, in the order a
 * Ghanaian address is actually said aloud.
 *
 * Region is a picker rather than a text box even though the column is free
 * text. It prices the delivery quote: `deliveryQuote` matches
 * `LOWER(zone.region)` and silently falls back to the national rate on a
 * spelling it does not know, so "Gt. Accra" is not an error, it is a wrong
 * price with no complaint. `GHANA_REGIONS` is the same list the seller's shop
 * settings picks from.
 */
export default function EditAddressScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string }>();
  const editingId = params.id ?? null;

  const addresses = useAddresses();
  const create = useCreateAddress();
  const update = useUpdateAddress();

  const existing = editingId ? addresses.data?.find((a) => a.id === editingId) : undefined;
  // Seeded once from the row and then owned by the form: re-seeding on every
  // render of a background refetch would wipe what the shopper is typing.
  const [seeded, setSeeded] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [phone, setPhone] = useState('');
  const [region, setRegion] = useState<string>(DEFAULT_REGION);
  const [city, setCity] = useState('');
  const [area, setArea] = useState('');
  const [landmark, setLandmark] = useState('');
  const [gps, setGps] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (editingId && existing && !seeded) {
    setSeeded(true);
    setRecipient(existing.recipient);
    setPhone(existing.phone);
    setRegion(existing.region);
    setCity(existing.city);
    setArea(existing.area ?? '');
    setLandmark(existing.landmark ?? '');
    setGps(existing.ghanapost_gps ?? '');
  }

  const saving = create.isPending || update.isPending;
  const complete =
    recipient.trim().length > 0 && phone.trim().length >= 7 && city.trim().length > 0;

  if (editingId && addresses.isPending) {
    return (
      <Screen>
        <Header title="Edit address" back />
        <Loading />
      </Screen>
    );
  }

  if (editingId && !existing) {
    return (
      <Screen>
        <Header title="Edit address" back />
        <ErrorState
          message={
            addresses.error
              ? apiErrorMessage(addresses.error, 'We could not load that address.')
              : 'That address is not in your book any more.'
          }
          onRetry={() => void addresses.refetch()}
        />
      </Screen>
    );
  }

  async function save(): Promise<void> {
    setError(null);
    // Blank optional fields are OMITTED rather than sent as null. The server
    // takes either since #87, but absent is what "the shopper did not fill
    // this in" actually means.
    const optional = {
      ...(area.trim() ? { area: area.trim() } : {}),
      ...(landmark.trim() ? { landmark: landmark.trim() } : {}),
      ...(gps.trim() ? { ghanapost_gps: gps.trim().toUpperCase() } : {}),
    };
    try {
      if (editingId) {
        await update.mutateAsync({
          id: editingId,
          recipient: recipient.trim(),
          phone: phone.trim(),
          region,
          city: city.trim(),
          // On an edit these are sent as null when cleared, so emptying a
          // landmark actually empties it rather than leaving the old one.
          area: area.trim() || null,
          landmark: landmark.trim() || null,
          ghanapost_gps: gps.trim() ? gps.trim().toUpperCase() : null,
        });
      } else {
        await create.mutateAsync({
          recipient: recipient.trim(),
          phone: phone.trim(),
          region,
          city: city.trim(),
          ...optional,
          // The first address a shopper saves becomes the default. Nothing on
          // the server does this — `is_default` defaults to false — so without
          // it a shopper with exactly one address has no default and checkout
          // quietly prices delivery nationally.
          is_default: (addresses.data?.length ?? 0) === 0,
        });
      }
      router.back();
    } catch (err) {
      setError(apiErrorMessage(err, 'We could not save that address.'));
    }
  }

  return (
    <Screen footerHeight={92}>
      <Header title={editingId ? 'Edit address' : 'Add an address'} back />

      <View style={styles.body}>
        <Field
          label="Who is it for"
          value={recipient}
          onChangeText={setRecipient}
          autoCapitalize="words"
          placeholder="Ama Boateng"
          hint="The name the rider will ask for. Add “(office)” or “(mum)” if you keep several."
        />
        <Field
          label="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="024 000 0002"
          hint="The rider calls this number, not the one on your account."
        />

        <SectionLabel>Region</SectionLabel>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {GHANA_REGIONS.map((r) => (
            <Chip key={r} label={r} selected={r === region} onPress={() => setRegion(r)} />
          ))}
        </ScrollView>

        <Field
          label="Town or city"
          value={city}
          onChangeText={setCity}
          autoCapitalize="words"
          placeholder="Accra"
          hint="What the delivery fee is worked out from."
        />
        <Field
          label="Street or neighbourhood"
          optional
          value={area}
          onChangeText={setArea}
          autoCapitalize="words"
          placeholder="House 14, Ring Road East, Osu"
        />
        <Field
          label="Landmark"
          optional
          value={landmark}
          onChangeText={setLandmark}
          placeholder="Near the Total filling station"
        />
        <Field
          label="GhanaPostGPS"
          optional
          value={gps}
          onChangeText={setGps}
          autoCapitalize="characters"
          placeholder="GA-183-4471"
        />

        <View style={styles.note}>
          <Text variant="tiny" tone="soft" style={styles.noteBody}>
            The five-and-four code from the GhanaPostGPS app. It is how a rider actually finds a
            door here, and it is the one field that turns “behind the blue kiosk” into an address.
          </Text>
        </View>

        {error ? (
          <Text variant="tiny" tone="accent">
            {error}
          </Text>
        ) : null}
      </View>

      <StickyFooter>
        <Button
          label={saving ? 'Saving…' : editingId ? 'Save changes' : 'Save this address'}
          loading={saving}
          disabled={!complete || saving}
          onPress={() => void save()}
        />
      </StickyFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, gap: space.lg, paddingTop: space.md },
  chips: { flexDirection: 'row', gap: space.sm, paddingRight: space.lg },
  note: { backgroundColor: color.surfaceSunk, borderRadius: radius.md, padding: space.md },
  noteBody: { lineHeight: 17 },
});
