import { z } from "zod";

export const FEEDBACK_CATEGORIES = [
  "Budget accuracy",
  "Weather information",
  "Itinerary quality",
  "Route efficiency",
  "Travel options",
  "Other",
] as const;

export const feedbackInputSchema = z.object({
  tripId: z.uuid(),
  rating: z.number().int().min(1).max(5),
  category: z.enum(FEEDBACK_CATEGORIES),
  comment: z.string().trim().min(10).max(2000),
}).strict();

export function sentimentForRating(rating: number): "Negative" | "Neutral" | "Positive" {
  return rating <= 2 ? "Negative" : rating === 3 ? "Neutral" : "Positive";
}
