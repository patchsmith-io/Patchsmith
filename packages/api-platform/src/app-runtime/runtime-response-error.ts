/** Let withSpan finish as ERROR without changing the fetch response contract. */
export class RuntimeResponseError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super(`App runtime returned HTTP ${response.status}`);
    this.name = "RuntimeResponseError";
    this.response = response;
  }
}
