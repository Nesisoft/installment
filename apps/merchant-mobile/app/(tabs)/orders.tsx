import React from 'react';
import { ComingNext } from '../../src/components/ComingNext';

export default function OrdersTab(): React.ReactElement {
  return (
    <ComingNext
      title="Orders"
      icon="box"
      body="The order queue, the settlement breakdown on each order, and confirming, shipping and delivering from your phone."
      meanwhile="Until then, the same orders are on the merchant portal on the web."
    />
  );
}
