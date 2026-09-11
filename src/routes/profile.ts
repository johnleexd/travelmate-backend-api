import { requireUser } from "../session.ts";
import { ProfileValidationError, updateProfile } from "../services/profile-service.ts";

function profileError(error: unknown): Response {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (error instanceof ProfileValidationError) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error("[TravelMate] Profile request failed:", error);
  return Response.json({ error: "Profile request failed." }, { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const profile = await requireUser(request);
    return Response.json({ profile });
  } catch (error) {
    return profileError(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    const input: unknown = await request.json().catch(() => {
      throw new ProfileValidationError("Request body must be valid JSON.");
    });
    const profile = await updateProfile(user.id, input);
    return Response.json({ profile });
  } catch (error) {
    return profileError(error);
  }
}
