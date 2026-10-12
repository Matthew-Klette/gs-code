/**
 * GTM built-in variable types (as the API returns them, lowerCamel) → the display name used in `{{…}}`.
 * Lets a built-in enabled locally in built-in-variables.json be referenced before the next pull.
 * Names pulled from the workspace stay authoritative; this table only fills gaps.
 */
export const BUILT_IN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // Pages
  pageUrl: 'Page URL',
  pageHostname: 'Page Hostname',
  pagePath: 'Page Path',
  referrer: 'Referrer',
  // Utilities
  event: 'Event',
  environmentName: 'Environment Name',
  containerId: 'Container ID',
  containerVersion: 'Container Version',
  randomNumber: 'Random Number',
  htmlId: 'HTML ID',
  // Errors
  errorMessage: 'Error Message',
  errorUrl: 'Error URL',
  errorLine: 'Error Line',
  debugMode: 'Debug Mode',
  // Clicks
  clickElement: 'Click Element',
  clickClasses: 'Click Classes',
  clickId: 'Click ID',
  clickTarget: 'Click Target',
  clickUrl: 'Click URL',
  clickText: 'Click Text',
  // Forms
  formElement: 'Form Element',
  formClasses: 'Form Classes',
  formId: 'Form ID',
  formTarget: 'Form Target',
  formUrl: 'Form URL',
  formText: 'Form Text',
  // History
  newHistoryFragment: 'New History Fragment',
  oldHistoryFragment: 'Old History Fragment',
  newHistoryState: 'New History State',
  oldHistoryState: 'Old History State',
  newHistoryUrl: 'New History URL',
  oldHistoryUrl: 'Old History URL',
  historySource: 'History Source',
  // Videos
  videoProvider: 'Video Provider',
  videoStatus: 'Video Status',
  videoUrl: 'Video URL',
  videoTitle: 'Video Title',
  videoDuration: 'Video Duration',
  videoCurrentTime: 'Video Current Time',
  videoPercent: 'Video Percent',
  videoVisible: 'Video Visible',
  // Scrolling
  scrollDepthThreshold: 'Scroll Depth Threshold',
  scrollDepthUnits: 'Scroll Depth Units',
  scrollDepthDirection: 'Scroll Direction',
  // Visibility
  elementVisibilityRatio: 'Percent Visible',
  elementVisibilityTime: 'On-Screen Duration',
  // Server containers
  clientName: 'Client Name',
  eventName: 'Event Name',
  queryString: 'Query String',
  requestMethod: 'Request Method',
  requestPath: 'Request Path',
  visitorRegion: 'Visitor Region',
};

/** `PAGE_URL` → `pageUrl`; lowerCamel types pass through unchanged. */
export function normalizeBuiltInType(type: string): string {
  if (!/^[A-Z0-9_]+$/.test(type)) return type;
  return type.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Display name for a built-in type: the pulled name if known, else GTM's standard name. */
export function builtInDisplayName(type: string, pulled: ReadonlyMap<string, string>): string | undefined {
  return pulled.get(type) ?? pulled.get(normalizeBuiltInType(type)) ?? BUILT_IN_DISPLAY_NAMES[normalizeBuiltInType(type)];
}
