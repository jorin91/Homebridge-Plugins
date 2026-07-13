'use strict';

const { normalizeFiniteNumber } = require('./unit-value-normalizers');

const COMPASS_SECTOR_DEGREES = 22.5;
const COMPASS_BOUNDARY_OFFSET_DEGREES = COMPASS_SECTOR_DEGREES / 2;

/**
 * <summary>
 * Lists the canonical Dutch 16-point compass abbreviations clockwise from north. The frozen exported sequence is
 * shared by conversion logic, documentation-oriented tests, and future weather-source integrations.
 * </summary>
 */
const DUTCH_COMPASS_16_DIRECTIONS = Object.freeze([
  'N',
  'NNO',
  'NO',
  'ONO',
  'O',
  'OZO',
  'ZO',
  'ZZO',
  'Z',
  'ZZW',
  'ZW',
  'WZW',
  'W',
  'WNW',
  'NW',
  'NNW',
]);

const COMPASS_DIRECTION_ALIASES = Object.freeze({
  N: 'N',
  NNO: 'NNO',
  NNE: 'NNO',
  NO: 'NO',
  NE: 'NO',
  ONO: 'ONO',
  ENE: 'ONO',
  O: 'O',
  E: 'O',
  OZO: 'OZO',
  ESE: 'OZO',
  ZO: 'ZO',
  SE: 'ZO',
  ZZO: 'ZZO',
  SSE: 'ZZO',
  Z: 'Z',
  S: 'Z',
  ZZW: 'ZZW',
  SSW: 'ZZW',
  ZW: 'ZW',
  SW: 'ZW',
  WZW: 'WZW',
  WSW: 'WZW',
  W: 'W',
  WNW: 'WNW',
  NW: 'NW',
  NNW: 'NNW',
});

/**
 * <summary>
 * Normalizes one Dutch or international 16-point compass abbreviation to the canonical Dutch notation used by
 * the plugin. Input is case-insensitive and may contain separating spaces, hyphens, or underscores. Variable,
 * calm, malformed, and unsupported direction text is rejected so it cannot be mistaken for north.
 * </summary>
 * @param {unknown} value Raw compass abbreviation supplied by a weather source.
 * @returns {string} Canonical Dutch 16-point compass abbreviation.
 * @throws {TypeError} When the value is not one supported Dutch or international compass abbreviation.
 */
function normalizeCompass16Direction(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Compass direction values must contain a supported abbreviation');
  }

  const token = value.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (!Object.prototype.hasOwnProperty.call(COMPASS_DIRECTION_ALIASES, token)) {
    throw new TypeError('Compass direction values must contain a supported abbreviation');
  }

  return COMPASS_DIRECTION_ALIASES[token];
}

/**
 * <summary>
 * Converts one Dutch or international 16-point compass abbreviation to the center angle of its sector. North is
 * zero degrees, east is 90, south is 180, and west is 270. Half-wind directions therefore produce 22.5-degree
 * increments rather than rounded integer approximations.
 * </summary>
 * @param {unknown} value Raw compass abbreviation supplied by a weather source.
 * @returns {number} Center angle from 0 through 337.5 degrees.
 * @throws {TypeError} When the direction is not part of the supported 16-point compass set.
 */
function convertCompass16ToDegrees(value) {
  const direction = normalizeCompass16Direction(value);
  return DUTCH_COMPASS_16_DIRECTIONS.indexOf(direction) * COMPASS_SECTOR_DEGREES;
}

/**
 * <summary>
 * Normalizes one numeric meteorological direction while enforcing the explicit zero-through-360-degree source
 * contract. The value is not wrapped because negative or overflowing provider data must reach the neutral path.
 * </summary>
 * @param {unknown} value Raw numeric direction supplied by a weather source.
 * @returns {number} Finite direction between 0 and 360 inclusive.
 * @throws {TypeError} When the value is not a finite number inside the supported direction range.
 */
function normalizeDegreeDirection(value) {
  const degrees = normalizeFiniteNumber(value);
  if (degrees < 0 || degrees > 360) {
    throw new TypeError('Degree direction values must be between 0 and 360');
  }

  return degrees;
}

/**
 * <summary>
 * Converts a finite meteorological direction from degrees clockwise from north into the canonical Dutch 16-point
 * compass abbreviation. Values must remain inside the explicit 0-through-360 source range; 360 is treated as the
 * equivalent of zero, while negative and overflowing values are rejected instead of silently wrapped.
 * </summary>
 * @param {unknown} value Raw numeric direction supplied by a weather source.
 * @returns {string} Canonical Dutch compass abbreviation for the containing 22.5-degree sector.
 * @throws {TypeError} When the value is not a finite number between 0 and 360 inclusive.
 */
function convertDegreesToCompass16(value) {
  const degrees = normalizeDegreeDirection(value);
  const normalizedDegrees = degrees === 360 ? 0 : degrees;
  const sectorIndex = Math.floor(
    (normalizedDegrees + COMPASS_BOUNDARY_OFFSET_DEGREES) / COMPASS_SECTOR_DEGREES,
  ) % DUTCH_COMPASS_16_DIRECTIONS.length;

  return DUTCH_COMPASS_16_DIRECTIONS[sectorIndex];
}

module.exports = {
  DUTCH_COMPASS_16_DIRECTIONS,
  normalizeCompass16Direction,
  normalizeDegreeDirection,
  convertCompass16ToDegrees,
  convertDegreesToCompass16,
};
