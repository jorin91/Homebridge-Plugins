'use strict';

/**
 * <summary>
 * Converts a source value to a finite JavaScript number suitable for a numeric HomeKit characteristic. Numeric
 * strings are accepted because JSON providers sometimes serialize measurements as text. Booleans, blank strings,
 * arrays, objects, NaN, and infinities are rejected so invalid provider data reaches the unit-specific neutral path.
 * </summary>
 * @param {unknown} value Raw value resolved from the configured source path.
 * @returns {number} Finite numeric representation of the source value.
 * @throws {TypeError} When the source value cannot represent one finite number.
 */
function normalizeFiniteNumber(value) {
  if (typeof value === 'boolean' || value === '' || value === null) {
    throw new TypeError('Weather unit values must contain a finite number');
  }

  if (typeof value === 'string' && value.trim() === '') {
    throw new TypeError('Weather unit values must contain a finite number');
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new TypeError('Weather unit values must contain a finite number');
  }

  return normalized;
}

/**
 * <summary>
 * Converts a source value to one signed integer for discrete code-based units such as WMO weather codes. This
 * preserves exact equality comparisons in HomeKit clients and rejects fractional source values instead of rounding
 * them into a different category.
 * </summary>
 * @param {unknown} value Raw value resolved from the configured source path.
 * @returns {number} Exact signed integer representation of the source value.
 * @throws {TypeError} When the source value is not a finite integer.
 */
function normalizeInteger(value) {
  const normalized = normalizeFiniteNumber(value);
  if (!Number.isInteger(normalized)) {
    throw new TypeError('Weather code values must contain an integer');
  }

  return normalized;
}

/**
 * <summary>
 * Normalizes an ISO 8601 source value while retaining the provider's original timezone and precision. Only a
 * non-empty string recognized by JavaScript's ISO-compatible date parser is accepted. The value is not converted
 * to UTC because a displayed local Open-Meteo time must keep the meaning selected by the source timezone.
 * </summary>
 * @param {unknown} value Raw date or date-time value resolved from the configured source path.
 * @returns {string} Trimmed original ISO 8601 text.
 * @throws {TypeError} When the value is not a parseable non-empty date or date-time string.
 */
function normalizeIso8601(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('ISO 8601 weather values must contain non-empty date text');
  }

  const normalized = value.trim();
  if (Number.isNaN(Date.parse(normalized))) {
    throw new TypeError('ISO 8601 weather values must contain a valid date or date-time');
  }

  return normalized;
}

module.exports = {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeIso8601,
};
