/**
 * Timezone utilities — zero external deps, uses Node's built-in Intl API.
 *
 * Key convention used throughout:
 *   getTzOffsetMs(tz, date)  returns  (UTC_ms − local_ms)
 *   → positive for zones west of UTC  (e.g. America/New_York EST = +18 000 000 ms)
 *   → negative for zones east of UTC  (e.g. Asia/Tokyo        = −32 400 000 ms)
 *
 * To convert  UTC  → local :   local_ms = UTC_ms − offsetMs
 * To convert local → UTC  :   UTC_ms  = local_ms + offsetMs
 */

/**
 * Returns (UTC_ms − local_ms) in milliseconds for the given timezone at `date`.
 * Handles DST automatically because the offset is recomputed at each call site.
 *
 * @param {string} timezone   IANA timezone id, e.g. 'America/New_York'
 * @param {Date}   [date]     Reference date (defaults to now)
 * @returns {number}          Offset in milliseconds
 */
function getTzOffsetMs(timezone, date = new Date()) {
  try {
    const utcMs   = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const localMs = new Date(date.toLocaleString('en-US', { timeZone: timezone })).getTime();
    return utcMs - localMs;
  } catch {
    return 0; // fallback: treat as UTC
  }
}

/**
 * Returns the current hour (0-23) in the given timezone.
 *
 * @param {string} timezone   IANA timezone id
 * @returns {number}          Hour 0-23
 */
function getHourInTz(timezone) {
  try {
    const now      = new Date();
    const offsetMs = getTzOffsetMs(timezone, now);
    // Shift now by the offset so getUTCHours() reads the local hour
    return new Date(now.getTime() - offsetMs).getUTCHours();
  } catch {
    return new Date().getHours(); // fallback: server local time
  }
}

module.exports = { getTzOffsetMs, getHourInTz };
