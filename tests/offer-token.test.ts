import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfferToken, verifyOfferToken, type OfferTokenData } from '../src/utils/offer-token.ts';

const offer: OfferTokenData = { hotelId: 'HOTEL1', offerId: 'OFFER1', name: 'Test Hotel', nightlyRate: 2500, isLive: false };

test('signed accommodation offers verify unchanged values', () => {
  const token = createOfferToken(offer);
  assert.equal(verifyOfferToken(offer, token), true);
});

test('signed accommodation offers reject browser price changes', () => {
  const token = createOfferToken(offer);
  assert.equal(verifyOfferToken({ ...offer, nightlyRate: 1 }, token), false);
});
