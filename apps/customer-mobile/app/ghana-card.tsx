import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { apiErrorMessage } from '@installment/mobile-kit';
import {
  Button,
  Card,
  ErrorState,
  Header,
  Icon,
  Loading,
  Pill,
  Screen,
  SectionLabel,
  Text,
} from '../src/components';
import { useGhanaCard, useSubmitGhanaCard } from '../src/features/account';
import { dateTime } from '../src/lib/dates';
import { isGhanaCardNumber, normaliseGhanaCardNumber } from '../src/lib/ghana-card';
import { color, radius, space } from '../src/theme/tokens';

type Picked = { uri: string; mimeType?: string | null; fileSize?: number | null };

/**
 * Ghana Card capture.
 *
 * The account tab has carried a "COMING SOON" pill here since the app shipped,
 * and it was accurate: `attachGhanaCard` had one caller, the admin console, so
 * a shopper had no way to send a card at all. Without one `verifyGhanaCard`
 * refuses, `kyc_tier` stays 0, and the 50 points a verified card is worth were
 * unreachable from the phone.
 *
 * The photo never travels through the API. `POST /me/uploads` mints a key
 * namespaced by the caller's own customer id, the phone PUTs the bytes straight
 * to storage, and only the key is attached — so the API never handles the image
 * and the key cannot be pointed at somebody else's folder.
 */
export default function GhanaCardScreen(): React.ReactElement {
  const card = useGhanaCard();
  const submit = useSubmitGhanaCard();
  const [cardNumber, setCardNumber] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (card.isPending) return <Loading />;
  if (card.isError) {
    return <ErrorState message={apiErrorMessage(card.error)} onRetry={() => void card.refetch()} />;
  }

  const state = card.data!;
  const numberOk = isGhanaCardNumber(cardNumber);
  // A rejected card is re-sendable; a submitted one is not, because sending
  // again while somebody is looking at the first only resets their queue.
  const canSend = state.status === null || state.status === 'rejected';

  async function pick(from: 'camera' | 'library') {
    setError(null);
    const permission =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        from === 'camera'
          ? 'We need permission to use the camera to photograph your card.'
          : 'We need permission to open your photos.',
      );
      return;
    }

    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      // The card is a fixed-ratio document and a reviewer needs to read the
      // number, so let them crop rather than sending the whole camera roll
      // frame — and cap the quality, because a 12MP original is a slow upload
      // on a Ghanaian mobile network for no extra legibility.
      allowsEditing: true,
      quality: 0.7,
    };
    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    const asset = result.assets[0];
    if (asset) setPicked({ uri: asset.uri, mimeType: asset.mimeType, fileSize: asset.fileSize });
  }

  async function send() {
    if (!picked || !numberOk) return;
    setError(null);
    try {
      // Canonicalised here as well as on the server, so the number echoed back
      // to the customer is the one they typed.
      await submit.mutateAsync({
        cardNumber: normaliseGhanaCardNumber(cardNumber) ?? cardNumber.trim(),
        image: picked,
      });
      setPicked(null);
      setCardNumber('');
    } catch (err) {
      setError(apiErrorMessage(err, 'The card could not be sent. Try again.'));
    }
  }

  return (
    <Screen scroll>
      <Header title="Ghana Card" back />

      <View style={styles.body}>
        <StatusCard state={state} />

        {canSend ? (
          <>
            <SectionLabel>
              {state.status === 'rejected' ? 'Send a new photo' : 'Send your card'}
            </SectionLabel>

            <Card style={styles.form}>
              <Text variant="tiny" tone="muted">
                Photograph the front of your card. Make sure the number and your name are readable —
                that is what a reviewer checks.
              </Text>

              {picked ? (
                <View>
                  <Image source={{ uri: picked.uri }} style={styles.preview} />
                  <Pressable onPress={() => setPicked(null)} style={styles.retake}>
                    <Text variant="tiny" tone="muted">
                      Choose a different photo
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.pickRow}>
                  <Button
                    label="Take a photo"
                    variant="outline"
                    onPress={() => void pick('camera')}
                    style={styles.pickButton}
                  />
                  <Button
                    label="From photos"
                    variant="outline"
                    onPress={() => void pick('library')}
                    style={styles.pickButton}
                  />
                </View>
              )}

              <View style={styles.field}>
                <Text variant="tiny" tone="muted">
                  Card number
                </Text>
                <TextInput
                  value={cardNumber}
                  onChangeText={setCardNumber}
                  placeholder="GHA-123456789-0"
                  placeholderTextColor={color.muted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.input}
                />
                {cardNumber.length > 0 && !numberOk ? (
                  <Text variant="tiny" tone="warn">
                    A Ghana Card number looks like GHA-123456789-0.
                  </Text>
                ) : null}
              </View>

              {error ? (
                <Text variant="tiny" tone="warn">
                  {error}
                </Text>
              ) : null}

              <Button
                label={submit.isPending ? 'Sending…' : 'Send for review'}
                onPress={() => void send()}
                disabled={!picked || !numberOk || submit.isPending}
              />
              <Text variant="tiny" tone="muted">
                A reviewer looks at it by hand — usually within a working day. We will never ask for
                your card by SMS or on a call.
              </Text>
            </Card>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

/** Where the card stands, in the words the customer needs. */
function StatusCard({
  state,
}: {
  state: ReturnType<typeof useGhanaCard>['data'] & object;
}): React.ReactElement {
  if (state.status === 'approved') {
    return (
      <Card style={styles.status}>
        <View style={styles.statusHead}>
          <Icon name="shield" size={18} color={color.success} />
          <Text variant="smallMedium">Your card is verified</Text>
          <Pill label="VERIFIED" tone="success" />
        </View>
        <Text variant="tiny" tone="muted">
          {state.card_number_masked} · verified{' '}
          {state.verified_at ? dateTime(state.verified_at) : ''}
        </Text>
      </Card>
    );
  }

  if (state.status === 'submitted') {
    return (
      <Card style={styles.status}>
        <View style={styles.statusHead}>
          <Icon name="search" size={18} color={color.warn} />
          <Text variant="smallMedium">We are checking your card</Text>
          <Pill label="IN REVIEW" tone="warn" />
        </View>
        <Text variant="tiny" tone="muted">
          {state.card_number_masked} · sent for review. Usually within a working day. You do not
          need to send it again.
        </Text>
      </Card>
    );
  }

  if (state.status === 'rejected') {
    return (
      <Card style={styles.status}>
        <View style={styles.statusHead}>
          <Icon name="x" size={18} color={color.warn} />
          <Text variant="smallMedium">Your card needs another look</Text>
        </View>
        {/* The reviewer's own words. A customer told only "not verified" has
            nothing to act on, which is the whole reason the reason is on the
            row and not only in the audit log. */}
        <Text variant="tiny">
          {state.rejection_reason ?? 'The photo could not be read. Please send a clearer one.'}
        </Text>
      </Card>
    );
  }

  return (
    <Card style={styles.status}>
      <View style={styles.statusHead}>
        <Icon name="shield" size={18} color={color.muted} />
        <Text variant="smallMedium">Verify your Ghana Card</Text>
      </View>
      <Text variant="tiny" tone="muted">
        A verified card raises the limit you can spread across instalments. It is the same card you
        use for a SIM or a bank account.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.md, paddingBottom: space.xl },
  status: { gap: space.sm },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  form: { gap: space.md },
  pickRow: { flexDirection: 'row', gap: space.sm },
  pickButton: { flex: 1 },
  preview: {
    width: '100%',
    aspectRatio: 1.6,
    borderRadius: radius.md,
    backgroundColor: color.border,
  },
  retake: { paddingTop: space.sm, alignItems: 'center' },
  field: { gap: space.xs },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 15,
    color: color.ink,
  },
});
