/** Raised by deliberately absent capabilities. Phase boundaries are explicit, never silent. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Raised before any network call when a public-source adapter lacks the credential or declared contact it
 * needs (SEC User-Agent contact, FRED API key, Alpaca data keys). The message never includes a value.
 */
export class MissingSourceCredentialError extends Error {
  readonly source: string;
  readonly credential: string;
  constructor(source: string, credential: string) {
    super(`${source}: missing required credential "${credential}"; set it in configuration (never in code)`);
    this.name = "MissingSourceCredentialError";
    this.source = source;
    this.credential = credential;
  }
}
