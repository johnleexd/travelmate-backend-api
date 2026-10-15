/** Provider metadata, not file extension or search rank, identifies artwork. */
export function nonPhotographicPlaceImage(evidence: string, creator = ''): boolean {
  // Some museum scans omit their medium and carry a modern upload date. A
  // documented creator lifespan ending before 1800 still proves historical art.
  const lifespan = creator.match(/\b(\d{4})\s*[-–]\s*(\d{4})\b/);
  const historicalArtist = !!lifespan && Number(lifespan[1]) >= 1000 && Number(lifespan[1]) <= Number(lifespan[2]) && Number(lifespan[2]) < 1800;
  return historicalArtist || /\b(flags?|logos?|coats? of arms|maps?|diagrams?|drawings?|illustrations?|paintings?|portraits?|engravings?|etchings?|lithographs?|woodcuts?|watercolou?rs?|sketch(?:es)?|prints?|AI[- ]generated)\b/i.test(evidence.replace(/<[^>]*>/g, ' ').replaceAll('_', ' '));
}
