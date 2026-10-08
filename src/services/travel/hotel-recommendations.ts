import { RapidHotelProvider } from './rapid-hotel-provider.ts';
import { LiteHotelProvider } from './lite-hotel-provider.ts';
import type { QuoteTicket } from './hotel-quote.ts';
export function revalidateHotelRecommendation(ticket: QuoteTicket) {
  return ticket.property.quote?.provider === 'liteapi' ? new LiteHotelProvider().revalidate(ticket) : new RapidHotelProvider().revalidate(ticket);
}
