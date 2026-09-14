export class EmailExistsError extends Error {
  constructor(message = "An account with this email already exists.") {
    super(message);
    this.name = "EmailExistsError";
  }
}
