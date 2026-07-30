/** A successful or expected-failure result. */
export type Result<T, E extends Error> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

/** Construct a successful result. */
export function ok<T>(value: T): Result<T, never> {
  return { _tag: "ok", value };
}

/** Construct an expected-failure result. */
export function err<E extends Error>(error: E): Result<never, E> {
  return { _tag: "err", error };
}
