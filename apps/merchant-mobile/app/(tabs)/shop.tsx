import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@installment/mobile-kit';
import { Button } from '../../src/components';
import { ComingNext } from '../../src/components/ComingNext';

export default function ShopTab(): React.ReactElement {
  const { signOut } = useAuth();
  const queryClient = useQueryClient();

  // Signing out here rather than waiting for the Shop screen to be built: an
  // app a seller cannot get out of is one they cannot hand to somebody else, or
  // use on a phone that is not only theirs. The cache goes with the session —
  // the next account to sign in must not see this shop's money.
  async function handleSignOut(): Promise<void> {
    await signOut();
    queryClient.clear();
  }

  return (
    <ComingNext
      title="Shop"
      icon="store"
      body="Your storefront, delivery zones, return policy, payout method and KYC documents."
      meanwhile="Until then, all of it is on the merchant portal on the web."
      footer={<Button label="Sign out" variant="outline" onPress={() => void handleSignOut()} />}
    />
  );
}
