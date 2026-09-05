import React from 'react';
import { ComingNext } from '../../src/components/ComingNext';

export default function ProductsTab(): React.ReactElement {
  return (
    <ComingNext
      title="Products"
      icon="grid"
      body="Your catalogue by variant, with stock per size, and listing a new product with photos, price and instalment terms."
      meanwhile="Until then, list and edit products on the merchant portal on the web."
    />
  );
}
