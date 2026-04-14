/**
 * Typed error classes for common server-side error conditions.
 */

/** Thrown when a tRPC procedure requires an integration that isn't connected. */
export class IntegrationNotConnectedError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`${provider} is not connected.`);
    this.name = "IntegrationNotConnectedError";
    this.provider = provider;
  }
}
