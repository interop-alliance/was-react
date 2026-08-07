/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Small JSON-LD shape helpers shared by the identity and auth layers (auth
 * already depends on identity, so this sits above both rather than inside
 * either).
 */

/**
 * Normalizes a JSON-LD term that may appear as a single value, as an array, or
 * not at all into an array. A missing (or otherwise empty) term becomes the
 * empty array. This is the `type` / `proof` / `allowedAction` idiom, in one
 * place.
 *
 * @param value {unknown}   the raw term value
 * @returns {Array}
 */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value
  }
  return value ? [value] : []
}
