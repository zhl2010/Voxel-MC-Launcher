/**
 * Remove credentials from anything that can reach the session log, DevTools console, or an issue
 * report. Keep normal URLs and command lines intact.
 */
export function redactSensitive(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(accessToken|clientToken|refreshToken|password|authorization)("?\s*[:=]\s*"?)([^\s",}]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[JWT REDACTED]')
}
