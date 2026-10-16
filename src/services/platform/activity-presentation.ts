type ActivityDescription = { label: string; targetType: string; tone: 'neutral' | 'success' | 'danger' | 'info' };
const event = (label: string, targetType = 'Record', tone: ActivityDescription['tone'] = 'neutral'): ActivityDescription => ({ label, targetType, tone });

// Presentation only. Stored audit values are immutable, including legacy events.
export const activityDescriptions: Record<string, ActivityDescription> = {
  'appeal-approved': event('Appeal approved', 'Appeal', 'success'),
  'appeal-rejected': event('Appeal rejected', 'Appeal', 'danger'),
  'submit-appeal': event('Appeal submitted', 'Appeal', 'info'),
  'save-trip': event('Trip saved', 'Trip', 'success'),
  'duplicate-trip': event('Trip duplicated', 'Trip', 'info'),
  'repair-empty-generated-days': event('Itinerary days repaired', 'Trip', 'info'),
  'update-trip': event('Trip regenerated', 'Trip', 'info'),
  'update-trip-itinerary': event('Itinerary updated', 'Trip', 'info'),
  'delete-trip': event('Trip deleted', 'Trip', 'danger'),
  'archive-trip': event('Trip archived', 'Trip'),
  'restore-trip': event('Trip restored', 'Trip', 'success'),
  'complete-trip': event('Trip completed', 'Trip', 'success'),
  'reopen-trip': event('Trip reopened', 'Trip', 'info'),
  'restore-itinerary-version': event('Itinerary version restored', 'Trip', 'info'),
  'google-login': event('Google login', 'User', 'info'),
  'google-register': event('Google account registered', 'User', 'success'),
  login: event('Login', 'User', 'info'), logout: event('Logout', 'User'),
  register: event('Account registered', 'User', 'success'),
  'verify-email': event('Email verified', 'User', 'success'),
  'update-profile': event('Profile updated', 'User', 'info'),
  'admin-user-status': event('Account status changed', 'User', 'info'),
  'admin-user-warning': event('Account warning sent', 'User'),
  'submit-report': event('Report submitted', 'Report', 'info'),
  'resolve-report': event('Report resolved', 'Report', 'success'),
  'submit-feedback': event('Feedback submitted', 'Feedback', 'info'),
  'update-feedback': event('Feedback updated', 'Feedback', 'info'),
  'activity-complete': event('Activity completed', 'Trip', 'success'),
  'activity-skip': event('Activity skipped', 'Trip'),
  'activity-plan': event('Activity planned', 'Trip', 'info'),
  'activity-edit': event('Activity edited', 'Trip', 'info'),
  'activity-reschedule': event('Activity rescheduled', 'Trip', 'info'),
  'accept-day-replan': event('Day replan accepted', 'Trip', 'success'),
};
export const activityPrefixes: Record<string, ActivityDescription> = {
  'plan:demo-plus:': event('Demo Plus granted', 'User', 'success'),
  'plan:paymongo-test-verified:': event('Test checkout verified', 'Checkout', 'success'),
};
export function describeActivity(action: string): ActivityDescription {
  return Object.hasOwn(activityDescriptions, action) ? activityDescriptions[action]
    : Object.entries(activityPrefixes).find(([prefix]) => action.startsWith(prefix))?.[1]
      ?? event('Other activity');
}

/** Search readable labels as well as codes, without searching embedded keys/reasons. */
export function matchingActivityCodes(query: string): string[] {
  const term = query.toLowerCase();
  return [...Object.entries(activityDescriptions), ...Object.entries(activityPrefixes)]
    .filter(([code, value]) => `${code} ${value.label}`.toLowerCase().includes(term))
    .map(([code]) => code);
}

/** Only recognized codes may be exposed by the legacy platform snapshot. */
export function safeActivityCode(action: string): string {
  if (Object.hasOwn(activityDescriptions, action)) return action;
  return Object.keys(activityPrefixes).find(prefix => action.startsWith(prefix))?.slice(0, -1) ?? 'other-activity';
}
