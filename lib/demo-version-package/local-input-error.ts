/** A refused local input (a stable code, never a path or a value). */
export class LocalInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
