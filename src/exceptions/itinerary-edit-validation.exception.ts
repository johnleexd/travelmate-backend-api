export class ItineraryEditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItineraryEditValidationError";
  }
}
