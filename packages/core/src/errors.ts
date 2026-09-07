/** Raised by deliberately absent capabilities. Phase boundaries are explicit, never silent. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
