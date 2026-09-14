export class PlatformActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformActionError";
  }
}
