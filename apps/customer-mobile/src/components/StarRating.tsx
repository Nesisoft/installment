import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { Text } from './Text';
import { color, space } from '../theme/tokens';

/**
 * How many stars, and the word for it.
 *
 * The ladder is the design's. It exists because a bare number is not a
 * judgement — "4" is arithmetic, "Good" is what the buyer meant — and because
 * on a 5-point scale people disagree most about the middle, so naming it
 * "Fine" rather than "Average" keeps three from reading as a failure.
 */
const WORD = ['', 'Poor', 'Not great', 'Fine', 'Good', 'Excellent'] as const;

export interface StarRatingProps {
  /** 0 means unrated, and the CTA stays disabled until it is not. */
  value: number;
  onChange?: (rating: number) => void;
  size?: number;
  /** The word under the stars. Off for a compact row. */
  showWord?: boolean;
}

/**
 * The app's only tappable rating control.
 *
 * The existing `Stars` in `app/product/[id].tsx` is a private, read-only
 * display — it renders an average and has no `onPress` — so until this there
 * was no way for a shopper to give a rating anywhere in the app, which is half
 * of why every rating surface in it was permanently empty.
 *
 * Starts at zero rather than a flattering default. A pre-selected four would be
 * the score most people never touch, and the CTA's whole disabled state
 * ("Choose a rating first") is unreachable if the control cannot be at zero.
 */
export function StarRating({
  value,
  onChange,
  size = 34,
  showWord = true,
}: StarRatingProps): React.ReactElement {
  const readOnly = !onChange;
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = n <= value;
          return (
            <Pressable
              key={n}
              accessibilityRole={readOnly ? 'image' : 'button'}
              accessibilityLabel={`${n} ${n === 1 ? 'star' : 'stars'}`}
              accessibilityState={{ selected: on }}
              disabled={readOnly}
              onPress={() => onChange?.(n)}
              // A 34px star is smaller than a fingertip. The hit box is padded
              // out rather than the star drawn larger.
              hitSlop={6}
              style={styles.star}
            >
              <Icon
                name={on ? 'star-filled' : 'star'}
                size={size}
                color={on ? color.accent : color.border}
              />
            </Pressable>
          );
        })}
      </View>
      {showWord ? (
        <Text variant="smallMedium" tone={value > 0 ? 'ink' : 'faint'}>
          {value > 0 ? WORD[value] : 'Tap a star'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', gap: space.xs },
  star: { padding: 2 },
});
