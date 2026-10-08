import { createHash, randomUUID } from 'node:crypto';
import { accommodationDistanceKm } from '../destination/accommodation-places.ts';
import { normalizeCurrency, currencyFractionDigits, hasValidCurrencyPrecision } from '../../schemas/domain.ts';
import { accommodationQuoteSchema, occupancySchema, sealQuote, type AccommodationQuote, type ProviderAccommodation, type PropertyPhoto, type QuoteTicket } from './hotel-quote.ts';
import { HotelQuoteError, isLatinContent, type HotelSearchInput } from './rapid-hotel-provider.ts';

type Json = Record<string, any>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const list = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj) : [];
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
export type LiteSearchInput = HotelSearchInput & { guestNationality: string; sessionId?: string };
export function liteConfigured(env: NodeJS.ProcessEnv = process.env) { return Boolean(env.LITEAPI_API_KEY && !env.LITEAPI_API_KEY.startsWith('your_')); }
export class LiteApiError extends HotelQuoteError {
  readonly code: string;
  constructor(message: string, code = 'provider-error') { super(message); this.code = code; }
}
const photoHosts = new Set(['static.cupid.travel', 'liteapi-travel-static-data.s3.amazonaws.com']);
export function litePhotos(hotel: Json, propertyId: string): PropertyPhoto[] {
  if (str(hotel.id) !== propertyId) return [];
  const images = [...list(hotel.hotelImages).sort((a,b) => Number(Boolean(b.defaultImage))-Number(Boolean(a.defaultImage))),
    ...(hotel.main_photo ? [{url: hotel.main_photo}] : [])];
  const seen = new Set<string>();
  return images.flatMap(image => {
    try {
      const url = new URL(str(image.url));
      if (url.protocol !== 'https:' || !photoHosts.has(url.hostname) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{reference: propertyId + ':' + url.pathname, url: url.href, caption: str(image.caption).slice(0,300), attribution: {
        creator: 'Hotel photos supplied by Nuitée Connect', license: 'Provider content terms',
        sourceUrl: url.href, licenseUrl: 'https://www.liteapi.travel/terms/',
      }}];
    } catch { return []; }
  }).slice(0,5);
}
function money(value: unknown) {
  const m = obj(value);
  if (typeof m.amount !== 'number' || !Number.isFinite(m.amount) || m.amount < 0) throw new Error('Missing quote');
  const currency = normalizeCurrency(str(m.currency));
  if (!hasValidCurrencyPrecision(m.amount, currency)) throw new Error('Invalid quote precision');
  return {amount: m.amount, currency};
}
export function liteRoomSignature(offer: Json): string {
  return createHash('sha256').update(JSON.stringify(list(offer.rates).map(rate => ({
    room: rate.mappedRoomId ?? rate.name, board: rate.boardType, adultCount: rate.adultCount,
    childCount: rate.childCount, childrenAges: rate.childrenAges, refundable: obj(rate.cancellationPolicies).refundableTag,
  })))).digest('hex');
}
export function liteQuote(offer: Json, propertyId: string, input: LiteSearchInput, photos: PropertyPhoto[], checkedAt: string): AccommodationQuote | undefined {
  try {
    const rooms = occupancySchema.parse(input.occupancy), rates = list(offer.rates);
    if (rates.length !== rooms.length || !str(offer.offerId)) return;
    if (rates.some((rate,i) => rate.adultCount !== rooms[i].adults || rate.childCount !== rooms[i].childAges.length
      || JSON.stringify(rate.childrenAges || []) !== JSON.stringify(rooms[i].childAges))) return;
    const quoted = money(offer.offerRetailRate);
    if (quoted.currency !== input.currency || quoted.amount <= 0) return;
    const factor = 10 ** currencyFractionDigits(quoted.currency);
    const roomTotals = rates.map(rate => {
      const totals = list(obj(rate.retailRate).total);
      if (totals.length !== 1) throw new Error('Missing room total');
      return money(totals[0]);
    });
    if (roomTotals.some(m => m.currency !== quoted.currency) || Math.round(quoted.amount*factor) !== roomTotals.reduce((sum,m) => sum+Math.round(m.amount*factor),0)) return;
    const rawFees = rates.flatMap(rate => list(obj(rate.retailRate).taxesAndFees));
    const taxDetails = rawFees.map(fee => ({
      description: str(fee.description).slice(0,100) || 'Tax or fee',
      ...(typeof fee.included === 'boolean' ? {included: fee.included} : {}),
      ...(typeof fee.amount === 'number' && Number.isFinite(fee.amount) && fee.amount >= 0 && /^[A-Z]{3}$/.test(str(fee.currency)) ? {amount: fee.amount, currency: str(fee.currency)} : {}),
    }));
    const feeDisclosureComplete = rates.every(rate => Object.hasOwn(obj(rate.retailRate), 'taxesAndFees')) && taxDetails.every(f => f.included !== undefined);
    const excluded = taxDetails.filter(fee => fee.included === false);
    const payableAtProperty = excluded.filter(f => f.amount !== undefined && f.currency).map(f => ({amount: f.amount!,currency: f.currency!}));
    const canBudget = excluded.every(fee => fee.amount !== undefined && fee.currency === quoted.currency && hasValidCurrencyPrecision(fee.amount, quoted.currency));
    const budgetTotal = canBudget ? (Math.round(quoted.amount*factor) + excluded.reduce((sum,f) => sum+Math.round(f.amount!*factor),0))/factor : undefined;
    const nights = (Date.parse(input.checkOutDate)-Date.parse(input.checkInDate))/86400000;
    return accommodationQuoteSchema.parse({
      provider: 'liteapi', propertyId, roomId: rates.map(rate => String(rate.mappedRoomId ?? '')).join(',') || str(offer.roomTypeId),
      offerId: str(offer.offerId), roomType: rates.map(rate => str(rate.name) || 'Room type unavailable').join(' + ').slice(0,300),
      guestNationality: input.guestNationality, checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, occupancy: rooms,
      currency: quoted.currency, total: quoted.amount, nightlyAverage: Math.round(quoted.amount/nights*factor)/factor,
      ...(feeDisclosureComplete ? {taxesAndFeesIncluded: !excluded.length} : {}), taxDetails, payableAtProperty,
      ...(budgetTotal !== undefined ? {budgetTotal} : {}),
      priceBreakdown: taxDetails.filter(f => f.amount !== undefined && f.currency).map(f => ({label: (f.included === true ? 'Included: ' : f.included === false ? 'Pay at property: ' : 'Inclusion unknown: ') + f.description, amount:f.amount!,currency:f.currency!})).slice(0,16),
      checkedAt, isLive:false, photoReferences:photos.map(p=>p.reference),
    });
  } catch { return; }
}
// Throttle across provider instances, below the documented sandbox ceiling of 5 requests/second.
let nextRequestAt = 0;
let currencyCache: {expiresAt:number; codes:Set<string>} | undefined;
export class LiteHotelProvider {
  private env: NodeJS.ProcessEnv;
  private fetcher: typeof fetch;
  readonly isLive = false;
  constructor(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
    this.env=env; this.fetcher=fetcher;
    if (!liteConfigured(env)) throw new LiteApiError('Hotel recommendations are not configured.', 'not-configured');
    if ((env.LITEAPI_ENV || 'sandbox') !== 'sandbox') throw new LiteApiError('Production hotel recommendations are disabled in this integration. Use sandbox configuration.', 'environment-mismatch');
    if (!env.LITEAPI_API_KEY!.startsWith('sand_')) throw new LiteApiError('LiteAPI sandbox configuration requires a sandbox API key.', 'environment-mismatch');
  }
  private async request(endpoint: string, body?: Json): Promise<Json> {
    // Explicit search/content-only allowlist. No booking host, prebook, payments or reservations.
    if (!['/data/hotels','/data/hotel','/data/currencies','/hotels/rates'].includes(endpoint.split('?')[0]) || Boolean(body) !== (endpoint === '/hotels/rates')) throw new LiteApiError('Unsupported hotel operation.');
    const at = Math.max(Date.now(), nextRequestAt); nextRequestAt=at+260;
    if (at>Date.now()) await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    let response: Response;
    try { response=await this.fetcher('https://api.liteapi.travel/v3.0'+endpoint,{
      method:body?'POST':'GET',headers:{'X-API-Key':this.env.LITEAPI_API_KEY!,accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(18000),redirect:'error',
    }); } catch(error) {
      const timeout = error instanceof Error && ['TimeoutError','AbortError'].includes(error.name);
      throw new LiteApiError(timeout ? 'Hotel search timed out. Refresh stays to retry.' : 'Hotel provider could not be reached. Refresh stays to retry.', timeout ? 'timeout' : 'network-error');
    }
    if (response.status===204) return {data:[],sandbox:true};
    const json = obj(await response.json().catch(()=>null));
    const code = Number(obj(json.error).code);
    if (response.status===401 || response.status===403 || code===401 || code===403) throw new LiteApiError('Hotel provider credentials were rejected. Ask the administrator to check LiteAPI configuration.', 'invalid-credentials');
    if (response.status===429 || code===429) throw new LiteApiError('Hotel provider rate limit reached. Wait a moment, then refresh stays.', 'rate-limited');
    if (!response.ok || json.error || !Object.hasOwn(json,'data')) throw new LiteApiError('Hotel provider returned an error (HTTP '+response.status+'). Refresh stays to retry.');
    if (endpoint==='/hotels/rates' && json.sandbox!==true) throw new LiteApiError('The provider did not confirm sandbox test data. Results were withheld.', 'environment-mismatch');
    return json;
  }
  private async supportedCurrency(currency: string) {
    // Currency reference codes only; no property, photo or rate response cache.
    if (!currencyCache || currencyCache.expiresAt<Date.now()) {
      const response=await this.request('/data/currencies');
      currencyCache={expiresAt:Date.now()+3600000,codes:new Set(list(response.data).map(c=>str(c.code)))};
    }
    if (!currencyCache.codes.has(currency)) throw new LiteApiError('This currency is not supported by the hotel provider. Choose a supported budget currency.', 'unsupported-currency');
  }
  private rateBody(input: LiteSearchInput, ids:string[]) {
    return {hotelIds:ids,checkin:input.checkInDate,checkout:input.checkOutDate,occupancies:input.occupancy.map(room=>({adults:room.adults,children:room.childAges})),
      currency:input.currency,guestNationality:input.guestNationality,roomMapping:true,maxRatesPerHotel:3,timeout:6,sessionId:input.sessionId};
  }
  async search(input: LiteSearchInput, userId:string):Promise<ProviderAccommodation[]> {
    const params=new URLSearchParams({latitude:String(input.latitude),longitude:String(input.longitude),radius:'10000',limit:'12',language:'en'});
    const listing=await this.request('/data/hotels?'+params);
    const hotels=list(listing.data).filter(h=>{
      const lat=Number(h.latitude),lon=Number(h.longitude);
      return /^lp[a-z0-9]+$/i.test(str(h.id)) && str(h.name) && Number.isFinite(lat) && Number.isFinite(lon)
        && accommodationDistanceKm(input.latitude,input.longitude,lat,lon)<=10
        && (!input.countryCode || str(h.country).toUpperCase()===input.countryCode.toUpperCase());
    });
    if (!hotels.length) return [];
    const canQuote = /^[A-Z]{2}$/.test(input.guestNationality);
    const sessionId=randomUUID(), searchInput={...input,sessionId};
    const ratesPromise=canQuote ? this.supportedCurrency(input.currency).then(()=>this.request('/hotels/rates',this.rateBody(searchInput,hotels.map(h=>h.id)))) : Promise.resolve({data:[],sandbox:true});
    const [pricing,details]=await Promise.all([ratesPromise.then(value=>({value,error:undefined as LiteApiError|undefined})).catch(error=>({value:{data:[]},error:error as LiteApiError})),
      Promise.all(hotels.map(async hotel=>{
        try { const response=await this.request('/data/hotel?'+new URLSearchParams({hotelId:hotel.id,language:'en',timeout:'4'}));return str(obj(response.data).id)===hotel.id ? obj(response.data) : hotel; }
        catch {return hotel;}
      }))]);
    const byId=new Map(list(pricing.value.data).map(h=>[str(h.hotelId),h]));
    return hotels.map((hotel,i)=>{
      const detail=details[i], photos=litePhotos(detail,hotel.id);
      const name=str(detail.name)||str(hotel.name), address=str(detail.address)||str(hotel.address)||'Address unavailable';
      const rates=obj(byId.get(hotel.id));
      const offers=list(rates.roomTypes);
      const choices=offers.map(offer=>({offer,quote:liteQuote(offer,hotel.id,searchInput,photos,new Date().toISOString())}))
        .filter(choice=>choice.quote).sort((a,b)=>a.quote!.total-b.quote!.total);
      const chosen=choices[0];
      const property:ProviderAccommodation={
        id:'liteapi:'+hotel.id,propertyId:hotel.id,name,nameSource:isLatinContent(name)?'provider-english':'unavailable',
        address,type:'Accommodation',latitude:Number(hotel.latitude),longitude:Number(hotel.longitude),
        distanceKm:Math.round(accommodationDistanceKm(input.latitude,input.longitude,Number(hotel.latitude),Number(hotel.longitude))*10)/10,
        ...(Number(detail.starRating||hotel.stars)>0 && Number(detail.starRating||hotel.stars)<=5 ? {rating:Number(detail.starRating||hotel.stars)} : {}),
        amenities:Array.isArray(detail.hotelFacilities)?detail.hotelFacilities.filter((f:unknown)=>typeof f==='string' && isLatinContent(f)).slice(0,12):[],
        photos,environment:'sandbox',...(pricing.error?{providerMessage:pricing.error.message}:{}),
        availability:pricing.error?'provider-error':chosen?'available':str(rates.status)==='sold_out'?'sold-out':offers.length?'price-unavailable':'unavailable',
        ...(chosen?{quote:chosen.quote}:{}),
      };
      return chosen ? {...property,quoteToken:sealQuote({userId,expiresAt:Date.now()+10*60000,destination:input.destination,latitude:input.latitude,longitude:input.longitude,
        property,priceCheckPath:'',liteSearch:{guestNationality:input.guestNationality,sessionId,roomSignature:liteRoomSignature(chosen.offer)}})} : property;
    });
  }
  async revalidate(ticket:QuoteTicket) {
    const previous=ticket.property.quote!;
    if (previous.provider!=='liteapi' || previous.isLive || !ticket.liteSearch || !previous.guestNationality) throw new HotelQuoteError('Refresh the selected hotel recommendation.','expired');
    const input:LiteSearchInput={destination:ticket.destination,latitude:ticket.latitude,longitude:ticket.longitude,checkInDate:previous.checkInDate,checkOutDate:previous.checkOutDate,
      occupancy:previous.occupancy,currency:previous.currency,guestNationality:previous.guestNationality,sessionId:ticket.liteSearch.sessionId};
    await this.supportedCurrency(input.currency);
    const response=await this.request('/hotels/rates',this.rateBody(input,[previous.propertyId]));
    const hotel=list(response.data).find(h=>h.hotelId===previous.propertyId);
    const offer=list(hotel?.roomTypes).find(o=>liteRoomSignature(o)===ticket.liteSearch!.roomSignature);
    if (!offer) throw new HotelQuoteError('This room offer is unavailable for your dates and guests. Refresh accommodations.','expired');
    const quote=liteQuote(offer,previous.propertyId,input,ticket.property.photos,new Date().toISOString());
    if (!quote || JSON.stringify([quote.currency,quote.total,quote.budgetTotal,quote.taxDetails])!==JSON.stringify([previous.currency,previous.total,previous.budgetTotal,previous.taxDetails]))
      throw new HotelQuoteError('The room price or fees changed. Refresh accommodations and review the new quote.','changed');
    if (quote.taxesAndFeesIncluded===false && quote.budgetTotal===undefined) throw new HotelQuoteError('Property-payable charges cannot be added to this budget currency. Choose another stay.','expired');
    return {...ticket.property,quote:{...quote,revalidatedAt:quote.checkedAt}};
  }
}
