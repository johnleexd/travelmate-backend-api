// Notify connected admins only after a report/appeal transaction commits.
const listeners = new Set<() => void>();
export function subscribeReportChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishReportChange(): void {
  for (const listener of listeners) listener();
}
