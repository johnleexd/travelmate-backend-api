import { GoogleAuth } from 'google-auth-library';
import { isLatinContent } from '../travel/rapid-hotel-provider.ts';

type NamedProperty = { name: string; address: string; originalName?: string; nameSource?: string };
export async function localizePropertyNames<T extends NamedProperty>(rows: T[], env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, getToken = async () => new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-translation'] }).getAccessToken()): Promise<T[]> {
  const pending = rows.flatMap((row, index) => !isLatinContent(row.name) ? [{ index, name: row.name }] : []);
  const localized = rows.map(row => ({ ...row, originalName: row.originalName || row.name,
    nameSource: !isLatinContent(row.name) ? 'unavailable' : row.nameSource || 'source-latin',
    address: isLatinContent(row.address) ? row.address : 'Address unavailable in English',
  }));
  if (!pending.length || !env.HOTEL_ROMANIZATION_PROJECT) return localized;
  if (!/^[a-zA-Z0-9-]+$/.test(env.HOTEL_ROMANIZATION_PROJECT) || !/^[a-z0-9-]+$/.test(env.HOTEL_ROMANIZATION_LOCATION || 'global')) return localized;
  try {
    const token = await getToken();
    const response = await fetcher('https://translation.googleapis.com/v3/projects/' + env.HOTEL_ROMANIZATION_PROJECT + '/locations/' + (env.HOTEL_ROMANIZATION_LOCATION || 'global') + ':romanizeText', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-goog-user-project': env.HOTEL_ROMANIZATION_PROJECT },
      body: JSON.stringify({ contents: pending.map(p => p.name) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return localized;
    const data = await response.json() as { romanizations?: Array<{ romanizedText?: string }> };
    pending.forEach((item, index) => {
      const text = data.romanizations?.[index]?.romanizedText?.trim();
      if (text && isLatinContent(text)) localized[item.index] = { ...localized[item.index], name: text.slice(0,150), nameSource: 'transliterated' };
    });
  } catch { /* Do not guess a brand name when the romanization provider is unavailable. */ }
  return localized;
}
