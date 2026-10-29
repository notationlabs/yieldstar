import { registerErrorClass } from "@yieldstar/core";

export class RetryableError extends Error {
  maxAttempts: number;
  retryInterval: number;
  constructor(
    message: string,
    opts: { maxAttempts: number; retryInterval: number }
  ) {
    super(message);
    this.name = "RetryableError";
    this.maxAttempts = opts.maxAttempts;
    this.retryInterval = opts.retryInterval;
  }
}

registerErrorClass("RetryableError", RetryableError);
