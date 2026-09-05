import React from 'react';
import { ComingNext } from '../../src/components/ComingNext';

export default function PayoutsTab(): React.ReactElement {
  return (
    <ComingNext
      title="Payouts"
      icon="wallet"
      body="Tonight's payout, the reserve held against each open plan and when it releases, and everything paid out before now."
      meanwhile="The Today screen already shows what is payable and what is held."
    />
  );
}
