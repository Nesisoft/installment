import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@installment/mobile-kit';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Loading,
  QuotedProductCard,
  Screen,
  SectionLabel,
  Text,
} from '../src/components';
import { useSearch, useTrending } from '../src/features/storefront';
import { useToggleWishlist, useWishlistIds } from '../src/features/account';
import { pluralise } from '../src/lib/format';
import { color, font, radius, space } from '../src/theme/tokens';
import type { TrendingTerm } from '../src/features/types';

/** How long the box stays quiet before the term reaches the API. */
const DEBOUNCE_MS = 300;

export default function SearchScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { signedIn } = useAuth();
  const input = useRef<TextInput>(null);

  // `query` is what the shopper is typing; `term` is what the API has been
  // asked for. They differ for at most a debounce interval.
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const { recent, remember } = useRecentSearches();

  const results = useSearch(term);
  const trending = useTrending();
  const wishlist = useWishlistIds(signedIn);
  const toggleSave = useToggleWishlist();
  const saved = new Set(wishlist.data ?? []);

  useEffect(() => {
    const next = query.trim();
    // Clearing the box returns to recents immediately: there is no request to
    // save there, and lagging 300ms behind the clear button reads as a freeze.
    if (next === '') {
      setTerm('');
      return;
    }
    const timer = setTimeout(() => setTerm(next), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /** A search the shopper asked for outright — submit, or a tap on a term. */
  function run(value: string): void {
    const next = value.trim();
    if (!next) return;
    setQuery(next);
    setTerm(next);
    remember(next);
    // Results are the answer to a deliberate search; the keyboard would cover
    // most of the first row.
    Keyboard.dismiss();
  }

  const searching = term.length > 0;
  const trendingTerms = trending.data ?? [];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={styles.back}
        >
          <Icon name="chevron-left" size={22} color={color.ink} />
        </Pressable>

        <View style={styles.field}>
          <Icon name="search" size={17} color={color.muted} />
          <TextInput
            ref={input}
            value={query}
            onChangeText={setQuery}
            placeholder="What are you looking for?"
            placeholderTextColor={color.mutedSoft}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.input}
            accessibilityLabel="Search the marketplace"
            onSubmitEditing={() => run(query)}
          />
          {query.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the search box"
              hitSlop={10}
              onPress={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              <Icon name="x" size={15} color={color.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <Screen>
        {searching ? (
          <View style={styles.body}>
            {results.isPending ? <Loading /> : null}
            {results.isError ? (
              <ErrorState
                message="We couldn't run that search just now."
                onRetry={() => void results.refetch()}
              />
            ) : null}

            {results.data ? (
              <View>
                {/* The hook keeps the previous term's rows on screen while the
                    next request is in flight, which stops the grid blanking
                    between keystrokes — but the total belongs to those older
                    rows, so say what is happening rather than quote a count
                    against the wrong word. */}
                <Text variant="smallMedium" tone="muted" style={styles.count}>
                  {results.isPlaceholderData
                    ? `Searching for "${term}"…`
                    : `${pluralise(results.data.total, 'result')} for "${term}"`}
                </Text>

                {results.data.rows.length === 0 && !results.isPlaceholderData ? (
                  <EmptyState
                    icon={<Icon name="search" size={30} color={color.mutedSoft} />}
                    title={`Nothing matched "${term}"`}
                    body="Try a shorter word or another spelling, or browse the categories to see what vendors have listed."
                    action={
                      <Button
                        label="Browse the marketplace"
                        variant="dark"
                        onPress={() => router.push('/browse')}
                      />
                    }
                  />
                ) : (
                  <View style={styles.grid}>
                    {results.data.rows.map((p) => (
                      <QuotedProductCard
                        key={p.id}
                        product={p}
                        saved={saved.has(p.id)}
                        onToggleSave={
                          signedIn
                            ? () => toggleSave.mutate({ productId: p.id, saved: saved.has(p.id) })
                            : undefined
                        }
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.body}>
            {recent.length > 0 ? (
              <View>
                <SectionLabel>RECENT</SectionLabel>
                <View style={styles.chips}>
                  {recent.map((t) => (
                    <Chip key={t} label={t} onPress={() => run(t)} />
                  ))}
                </View>
              </View>
            ) : null}

            {/* No heading over an empty list: trending is a suggestion, and an
                empty "TRENDING" reads as something that failed to load. */}
            {trendingTerms.length > 0 ? (
              <View>
                <SectionLabel>TRENDING</SectionLabel>
                <View style={styles.trending}>
                  {trendingTerms.map((t, i) => (
                    <TrendingRow
                      key={t.term}
                      rank={i + 1}
                      entry={t}
                      divider={i > 0}
                      onPress={() => run(t.term)}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {/* First run on a handset with nothing trending: the screen would
                otherwise be an empty field with no idea of what it accepts. */}
            {recent.length === 0 && trendingTerms.length === 0 && !trending.isPending ? (
              <Text variant="small" tone="muted" style={styles.hint}>
                Search for a product, a brand or a shop — "gas cooker", "Infinix", "school shoes".
              </Text>
            ) : null}
          </View>
        )}
      </Screen>
    </View>
  );
}

/** One line of the trending list: "1 · iphone 13 · 1,204 searches". */
function TrendingRow({
  rank,
  entry,
  divider,
  onPress,
}: {
  rank: number;
  entry: TrendingTerm;
  /** Hairline above every row but the first, so the list has no trailing rule. */
  divider: boolean;
  onPress: () => void;
}): React.ReactElement {
  // `pluralise`'s default plural appends an s — "searchs" — so the noun is given.
  const count = pluralise(entry.searches, 'search', 'searches');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Search for ${entry.term}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.trendRow,
        divider && styles.trendDivider,
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text variant="smallMedium" tone="faint" style={styles.rank}>
        {rank}
      </Text>
      <View style={styles.trendText}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {entry.term}
        </Text>
        <Text variant="tiny" tone="muted">
          {count}
        </Text>
      </View>
      <Icon name="chevron-right" size={16} color={color.mutedSoft} />
    </Pressable>
  );
}

const RECENT_KEY = 'ejua.recent-searches';
const RECENT_LIMIT = 6;

/**
 * The last few searches, kept on the handset.
 *
 * Only a deliberate search is remembered — a submit or a tap on a term, not
 * every debounced pause — otherwise the list fills with the prefixes of one
 * word ("ipho", "iphon", "iphone"). Storage failures are swallowed: search
 * history is a convenience, and it is not worth a single error in front of a
 * shopper who is trying to find something.
 */
function useRecentSearches(): { recent: string[]; remember: (value: string) => void } {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENT_KEY);
        if (!raw || !live) return;
        const parsed: unknown = JSON.parse(raw);
        // Anything could sit under this key — an older build, a half-written
        // value — so only the strings survive the read.
        if (!Array.isArray(parsed)) return;
        setRecent(parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT));
      } catch {
        // Unreadable history simply means there is none to show.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const remember = useCallback(
    (value: string) => {
      const next = value.trim();
      if (!next) return;
      // Matched case-insensitively so "Infinix" does not sit beside "infinix",
      // but stored as typed.
      const merged = [next, ...recent.filter((t) => t.toLowerCase() !== next.toLowerCase())].slice(
        0,
        RECENT_LIMIT,
      );
      setRecent(merged);
      void persistRecent(merged);
    },
    [recent],
  );

  return { recent, remember };
}

async function persistRecent(terms: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(terms));
  } catch {
    // A history that failed to save is not worth interrupting the search.
  }
}

/**
 * Two columns with a gutter, measured rather than flexed — `flex: 1` in a
 * wrapping row stretches the single card on an odd last row to full width.
 */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  back: { padding: 2 },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surfaceSunk,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 42,
  },
  // Android gives a TextInput its own vertical padding, which pushes the text
  // off the centre line the icon sits on.
  input: {
    flex: 1,
    paddingVertical: 0,
    color: color.ink,
    fontFamily: font.regular,
    fontSize: 15,
  },
  body: { gap: space.xxl, paddingTop: space.lg },
  count: { paddingHorizontal: space.lg, marginBottom: space.md },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg },
  trending: { paddingHorizontal: space.lg },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  trendDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.borderSoft,
  },
  rank: { width: 16 },
  trendText: { flex: 1, gap: 1 },
  hint: { paddingHorizontal: space.lg },
});
