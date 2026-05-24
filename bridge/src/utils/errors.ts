export class HermesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesError';
  }
}

export class HermesConnectionError extends HermesError {
  constructor(message: string) {
    super(message);
    this.name = 'HermesConnectionError';
  }
}

export class HermesApiError extends HermesError {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HermesApiError';
    this.statusCode = statusCode;
  }
}
