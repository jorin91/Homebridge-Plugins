'use strict';

const MINUTES_PER_DAY = 24 * 60;
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const DEFAULT_DAY_INDEXES = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const DAY_NAMES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const DAY_ALIASES = Object.freeze({
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
});

/**
 * <summary>
 * Converts raw Homebridge schedule entries into normalized entries that can be
 * evaluated without repeatedly parsing strings. Invalid entries are skipped and
 * reported through the logger so one malformed window does not prevent the
 * platform from loading the rest of the configured virtual switches.
 * </summary>
 * @param {Array<object>} rawEntries Raw `entries` array from a device config.
 * @param {Function|object} log Homebridge logger used for validation warnings.
 * @param {string} ownerLabel Human-readable device label included in warnings.
 * @returns {Array<object>} Normalized schedule entries.
 */
function normalizeSchedule(rawEntries, log, ownerLabel) {
  if (rawEntries === undefined || rawEntries === null) {
    return [];
  }

  if (!Array.isArray(rawEntries)) {
    writeWarning(log, `${formatOwner(ownerLabel)} schedule entries must be an array. The device will stay off unless inverse state is enabled.`);
    return [];
  }

  return rawEntries.reduce((entries, rawEntry, index) => {
    const entry = normalizeEntry(rawEntry, index, log, ownerLabel);

    if (entry) {
      entries.push(entry);
    }

    return entries;
  }, []);
}

/**
 * <summary>
 * Evaluates whether the current local date and time falls inside any configured schedule range. Invalid or empty schedules return false because a normal time switch is active only inside configured ranges.
 * </summary>
 * @param {Array<object>} entries Normalized schedule entries.
 * @param {Date} date Local date and time to evaluate.
 * @returns {boolean} True when the current time is inside a configured range.
 */
function isActiveAt(entries, date) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }

  return entries.some((entry) => isEntryActiveAt(entry, date));
}

/**
 * <summary>
 * Finds the next configured start or end boundary after the supplied local time.
 * Boundary timers are the authoritative moments where schedule control resumes
 * after any manual override.
 * </summary>
 * @param {Array<object>} entries Normalized schedule entries.
 * @param {Date} date Search origin as local date and time.
 * @returns {Date|null} Next future boundary, or null when no schedule exists.
 */
function findNextBoundaryAfter(entries, date) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const today = createLocalMidnight(date);
  const nowTime = date.getTime();
  let nearestBoundary = null;

  entries.forEach((entry) => {
    for (let dayOffset = -1; dayOffset <= 8; dayOffset += 1) {
      const windowStartDay = addDays(today, dayOffset);

      if (!entry.dayIndexes.includes(windowStartDay.getDay())) {
        continue;
      }

      const boundaries = createEntryBoundaries(windowStartDay, entry);
      nearestBoundary = chooseEarlierFutureDate(nearestBoundary, boundaries.start, nowTime);
      nearestBoundary = chooseEarlierFutureDate(nearestBoundary, boundaries.end, nowTime);
    }
  });

  return nearestBoundary;
}

/**
 * <summary>
 * Finds the next periodic check time aligned to a local midnight grid. For a
 * 15-minute interval, this produces checks at :00, :15, :30, and :45 rather than
 * relative to Homebridge startup time.
 * </summary>
 * @param {Date} date Search origin as local date and time.
 * @param {number} intervalMinutes Positive interval length in minutes.
 * @returns {Date|null} Next local grid boundary, or null when the interval is invalid.
 */
function findNextIntervalBoundaryAfter(date, intervalMinutes) {
  const parsedInterval = Math.floor(Number(intervalMinutes));

  if (!Number.isFinite(parsedInterval) || parsedInterval < 1) {
    return null;
  }

  const midnight = createLocalMidnight(date);
  const elapsedMs = Math.max(0, date.getTime() - midnight.getTime());
  const intervalMs = parsedInterval * MILLISECONDS_PER_MINUTE;
  const nextElapsedMs = Math.floor(elapsedMs / intervalMs + 1) * intervalMs;
  const nextMinuteOfDay = Math.floor(nextElapsedMs / MILLISECONDS_PER_MINUTE);

  if (nextMinuteOfDay >= MINUTES_PER_DAY) {
    return addDays(midnight, 1);
  }

  return createLocalTime(midnight, nextMinuteOfDay, 0);
}

/**
 * <summary>
 * Parses a strict local 24-hour `HH:mm` value into minutes since midnight. The
 * helper rejects partial and locale-specific formats so config behaves the same
 * across machines.
 * </summary>
 * @param {string} value Configured time value.
 * @returns {number|null} Minute offset, or null when invalid.
 */
function parseTimeToMinutes(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value.trim());

  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * <summary>
 * Normalizes one configured on-window. It validates the required start and end
 * times, converts day labels into JavaScript day indexes, and keeps only the
 * structured data needed for schedule evaluation and boundary calculation.
 * </summary>
 * @param {object} rawEntry Raw schedule entry from device config.
 * @param {number} index Zero-based entry index used in warnings.
 * @param {Function|object} log Homebridge logger.
 * @param {string} ownerLabel Human-readable device label included in warnings.
 * @returns {object|null} Normalized entry or null when unusable.
 */
function normalizeEntry(rawEntry, index, log, ownerLabel) {
  if (!rawEntry || typeof rawEntry !== 'object') {
    writeWarning(log, `${formatOwner(ownerLabel)} schedule entry ${index + 1} must be an object and was skipped.`);
    return null;
  }

  const startMinutes = parseTimeToMinutes(rawEntry.start);
  const endMinutes = parseTimeToMinutes(rawEntry.end);

  if (startMinutes === null || endMinutes === null) {
    writeWarning(log, `${formatOwner(ownerLabel)} schedule entry ${index + 1} needs start and end times formatted as HH:mm.`);
    return null;
  }

  const dayIndexes = normalizeDayIndexes(rawEntry.days);

  if (dayIndexes.length === 0) {
    writeWarning(log, `${formatOwner(ownerLabel)} schedule entry ${index + 1} has no valid days and was skipped.`);
    return null;
  }

  return {
    dayIndexes,
    startMinutes,
    endMinutes,
    label: `${dayIndexes.map((dayIndex) => DAY_NAMES[dayIndex]).join(',')} ${formatMinutes(startMinutes)}-${formatMinutes(endMinutes)}`
  };
}

/**
 * <summary>
 * Converts optional configured day labels into JavaScript day indexes. Missing
 * or empty day lists intentionally mean every day, matching the common behavior
 * of a physical time clock where a window applies daily unless narrowed.
 * </summary>
 * @param {Array<string>} rawDays Optional configured day labels.
 * @returns {Array<number>} Sorted day indexes where Sunday is 0.
 */
function normalizeDayIndexes(rawDays) {
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    return DEFAULT_DAY_INDEXES.slice();
  }

  return rawDays.reduce((indexes, rawDay) => {
    const dayIndex = DAY_ALIASES[String(rawDay).trim().toLowerCase()];

    if (typeof dayIndex === 'number' && !indexes.includes(dayIndex)) {
      indexes.push(dayIndex);
    }

    return indexes;
  }, []).sort((left, right) => left - right);
}

/**
 * <summary>
 * Evaluates one normalized on-window. Equal start and end values represent a
 * full configured day. An end earlier than the start represents an overnight
 * window that remains active after midnight on the following calendar day.
 * </summary>
 * @param {object} entry Normalized schedule entry.
 * @param {Date} date Local date and time to evaluate.
 * @returns {boolean} True when this entry is active.
 */
function isEntryActiveAt(entry, date) {
  const currentDayIndex = date.getDay();
  const currentMinute = date.getHours() * 60 + date.getMinutes();

  if (entry.startMinutes === entry.endMinutes) {
    return entry.dayIndexes.includes(currentDayIndex);
  }

  if (entry.startMinutes < entry.endMinutes) {
    return entry.dayIndexes.includes(currentDayIndex) &&
      currentMinute >= entry.startMinutes &&
      currentMinute < entry.endMinutes;
  }

  return (entry.dayIndexes.includes(currentDayIndex) && currentMinute >= entry.startMinutes) ||
    (entry.dayIndexes.includes((currentDayIndex + 6) % 7) && currentMinute < entry.endMinutes);
}

/**
 * <summary>
 * Creates the start and end trigger boundaries for a normalized entry on one
 * configured start day. Full-day windows trigger at local midnight and at the
 * next local midnight. Timed windows trigger at their configured start and end
 * times, with overnight windows ending on the next calendar day.
 * </summary>
 * @param {Date} windowStartDay Local midnight of the configured entry day.
 * @param {object} entry Normalized schedule entry.
 * @returns {{start: Date, end: Date}} Start and end trigger boundaries.
 */
function createEntryBoundaries(windowStartDay, entry) {
  if (entry.startMinutes === entry.endMinutes) {
    return {
      start: createLocalTime(windowStartDay, 0, 0),
      end: createLocalTime(windowStartDay, 0, 1)
    };
  }

  return {
    start: createLocalTime(windowStartDay, entry.startMinutes, 0),
    end: createLocalTime(windowStartDay, entry.endMinutes, entry.startMinutes > entry.endMinutes ? 1 : 0)
  };
}

/**
 * <summary>
 * Creates local midnight for the supplied date. Local calendar construction
 * keeps daylight-saving transitions aligned with the machine timezone instead
 * of assuming a fixed UTC offset.
 * </summary>
 * @param {Date} date Source date.
 * @returns {Date} Local midnight for that calendar date.
 */
function createLocalMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * <summary>
 * Creates a local schedule boundary using a base day, minute offset, and extra
 * day offset. The extra day supports overnight windows without mutating the
 * original Date object.
 * </summary>
 * @param {Date} baseDay Local midnight for the configured entry day.
 * @param {number} minuteOfDay Minutes since midnight.
 * @param {number} extraDays Calendar days to add to the base day.
 * @returns {Date} Local schedule boundary.
 */
function createLocalTime(baseDay, minuteOfDay, extraDays) {
  return new Date(
    baseDay.getFullYear(),
    baseDay.getMonth(),
    baseDay.getDate() + extraDays,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
    0
  );
}

/**
 * <summary>
 * Adds whole calendar days using local Date construction. This avoids fixed
 * millisecond offsets that can drift by an hour around daylight-saving changes.
 * </summary>
 * @param {Date} date Source local date.
 * @param {number} days Number of calendar days to add.
 * @returns {Date} Local date at midnight after the offset.
 */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

/**
 * <summary>
 * Chooses the earlier future boundary while ignoring boundaries at or before the
 * current time. This keeps each scheduler loop focused on its next trigger.
 * </summary>
 * @param {Date|null} currentNearest Current nearest candidate.
 * @param {Date} candidate Candidate schedule boundary.
 * @param {number} nowTime Current time in milliseconds.
 * @returns {Date|null} Earlier future candidate or the unchanged current value.
 */
function chooseEarlierFutureDate(currentNearest, candidate, nowTime) {
  if (candidate.getTime() <= nowTime) {
    return currentNearest;
  }

  if (!currentNearest || candidate.getTime() < currentNearest.getTime()) {
    return candidate;
  }

  return currentNearest;
}

/**
 * <summary>
 * Formats minute offsets as `HH:mm` for stable diagnostic labels. It avoids
 * locale-specific Date formatting so labels stay compact in logs and context.
 * </summary>
 * @param {number} minuteOfDay Minutes since midnight.
 * @returns {string} Formatted time string.
 */
function formatMinutes(minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * <summary>
 * Formats an optional device label for warning messages. This keeps scheduler
 * validation reusable across many configured virtual switches while still
 * pointing the user at the device that needs attention.
 * </summary>
 * @param {string} ownerLabel Device label from platform config.
 * @returns {string} Warning prefix.
 */
function formatOwner(ownerLabel) {
  return ownerLabel ? `ScheduledSwitch device '${ownerLabel}'` : 'ScheduledSwitch device';
}

/**
 * <summary>
 * Writes a warning through the Homebridge logger without assuming the logger has
 * a modern `warn` method. This keeps validation diagnostics from becoming a
 * startup failure on older or mocked Homebridge runtimes.
 * </summary>
 * @param {Function|object} log Homebridge logger.
 * @param {string} message Warning text.
 */
function writeWarning(log, message) {
  if (log && typeof log.warn === 'function') {
    log.warn(message);
    return;
  }

  if (typeof log === 'function') {
    log(message);
  }
}

module.exports = {
  normalizeSchedule,
  isActiveAt,
  findNextBoundaryAfter,
  findNextIntervalBoundaryAfter,
  parseTimeToMinutes
};



