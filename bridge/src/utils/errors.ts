export class OpenClawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawError';
  }
}

export class OpenClawConnectionError extends OpenClawError {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawConnectionError';
  }
}

export class OpenClawApiError extends OpenClawError {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'OpenClawApiError';
    this.statusCode = statusCode;
  }
}
