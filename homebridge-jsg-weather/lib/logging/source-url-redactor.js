'use strict';

const REDACTED_VALUE = '[redacted]';
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|app[-_]?id|access[-_]?token|refresh[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|credential|key|login|pass(?:[-_]?word|wd)?|pwd|secret|token|user(?:[-_]?name|[-_]?id)?)/i;

/**
 * <summary>
 * Produces a log-safe representation of an HTTP source URL by removing authority credentials and masking query
 * values whose names commonly contain credentials. Invalid URLs use a constant label so their text is never leaked.
 * </summary>
 * @param {unknown} source Source URL supplied through plugin configuration.
 * @returns {string} Redacted absolute URL or a safe invalid-source label.
 */
function redactSourceUrl(source) {
  try {
    const url = new URL(String(source));

    url.username = '';
    url.password = '';

    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }

    return url.toString();
  } catch {
    return '[invalid source URL]';
  }
}

module.exports = {
  redactSourceUrl,
};
