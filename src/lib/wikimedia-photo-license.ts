/** Commons rights metadata must name an approved reusable license. */
export function reusableWikimediaLicense(license: string, suppliedUrl?: string): string | null {
  const cc = license.match(/^CC (BY(?:-SA)?) (1\.0|2\.0|2\.5|3\.0|4\.0)$/i);
  const canonical = cc ? `https://creativecommons.org/licenses/${cc[1].toLowerCase()}/${cc[2]}/`
    : /^CC0(?: 1\.0)?$/i.test(license) ? 'https://creativecommons.org/publicdomain/zero/1.0/'
    : /^public domain$/i.test(license) ? 'https://creativecommons.org/publicdomain/mark/1.0/'
    : license === 'KOGL Type 1' ? 'https://www.kogl.or.kr/info/licenseType1.do' : null;
  if (!canonical || license === 'KOGL Type 1' && !suppliedUrl) return null;
  if (!suppliedUrl) return canonical;
  try {
    const url = new URL(suppliedUrl), expected = new URL(canonical);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const pathname = url.pathname.replace(/\/(?:deed(?:\.[a-z_-]+)?|legalcode(?:\.[a-z_-]+)?)\/?$/i, '/').replace(/\/$/, '');
    return url.hostname.replace(/^www\./, '') === expected.hostname.replace(/^www\./, '') && pathname === expected.pathname.replace(/\/$/, '') ? canonical : null;
  } catch { return null; }
}
