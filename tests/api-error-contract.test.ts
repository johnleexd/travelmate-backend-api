import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { API_ERROR_CODES, apiErrorPayload, normalizeApiError } from "../src/contracts/api-error.ts";
import { SUPPORTED_CURRENCIES } from "../src/schemas/domain.ts";

test("OpenAPI error codes stay aligned with the runtime contract", async () => {
  const document = JSON.parse(await readFile(new URL("../openapi/travelmate-api.json", import.meta.url), "utf8"));
  assert.deepEqual(document.components.schemas.ApiError.properties.code.enum, API_ERROR_CODES);
  assert.deepEqual(document.components.schemas.ApiError.required, ["error", "code", "retryable"]);
});

test("destination contract currency and required fields stay aligned", async () => {
  const document = JSON.parse(await readFile(new URL("../openapi/travelmate-api.json", import.meta.url), "utf8"));
  const schemas = document.components.schemas;
  assert.deepEqual(schemas.CurrencyCode.enum, SUPPORTED_CURRENCIES);
  assert.deepEqual(schemas.DestinationContext.required, ["currency", "currencySource", "transportation", "transportationSource", "transportationMessage"]);
  assert.deepEqual(schemas.LocationSuggestion.required, ["id", "name", "region", "country", "countryCode", "latitude", "longitude", "label", "placeType", "contextLabel"]);
  assert.ok(schemas.ExchangeRateQuote.required.includes("freshness"));
  assert.ok(schemas.LiveAccommodation.required.includes("selectionToken"));
});

test("weather and crowd response schemas require provenance metadata", async () => {
  const document = JSON.parse(await readFile(new URL("../openapi/travelmate-api.json", import.meta.url), "utf8"));
  const schemas = document.components.schemas;
  assert.deepEqual(schemas.CrowdCondition.properties.crowdSource.enum, ["estimated"]);
  assert.deepEqual(schemas.CrowdCondition.properties.crowdConfidence.enum, ["low"]);
  assert.ok(schemas.WeatherData.required.includes("freshness"));
  assert.ok(schemas.WeatherData.required.includes("crowd"));
  assert.deepEqual(schemas.WeatherData.properties.forecast.items.$ref, "#/components/schemas/ForecastDay");
});

test("travel comparison schemas preserve provider and freshness disclosures", async () => {
  const document = JSON.parse(await readFile(new URL("../openapi/travelmate-api.json", import.meta.url), "utf8"));
  const schemas = document.components.schemas;
  assert.deepEqual(schemas.FlightOption.properties.provider.enum, ["amadeus"]);
  assert.deepEqual(schemas.ActivityOption.properties.provider.enum, ["amadeus", "travelmate"]);
  assert.ok(schemas.TravelOptionsResponse.required.includes("freshness"));
  assert.deepEqual(schemas.TravelOptionFreshness.required, ["flights", "activities"]);
  assert.ok(schemas.FlightOption.required.includes("fetchedAt"));
  assert.ok(schemas.ActivityOption.required.includes("isLive"));
});

test("core account, itinerary, saved-trip, and platform responses are authoritative", async () => {
  const document = JSON.parse(await readFile(new URL("../openapi/travelmate-api.json", import.meta.url), "utf8"));
  const schemas = document.components.schemas;
  assert.equal(document.paths["/api/auth"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/CurrentUserResponse");
  assert.equal(document.paths["/api/profile"].patch.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/ProfileResponse");
  assert.equal(document.paths["/api/itinerary"].post.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/ItineraryResponse");
  assert.equal(document.paths["/api/platform"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/PlatformResponse");
  assert.deepEqual(schemas.ItineraryResponse.properties.days.items.$ref, "#/components/schemas/DayPlan");
  assert.equal(schemas.SelectedTravelCosts.properties.preTrip.$ref, "#/components/schemas/PreTripCosts");
  assert.deepEqual(schemas.PreTripCosts.properties.passportStatus.enum, ["valid", "needs_application", "needs_renewal", "not_sure"]);
  assert.equal(schemas.SavedTrip.properties.itinerary["x-typescript-type"], "unknown");
  assert.ok(schemas.PlatformResponse.required.includes("itineraryVersions"));
  assert.ok(schemas.PlatformResponse.required.includes("itineraryGenerations"));
});

test("legacy controller errors receive stable code and retry metadata", () => {
  assert.deepEqual(normalizeApiError({ error: "Too many requests." }, 429), { error: "Too many requests.", code: "RATE_LIMITED", retryable: true });
  assert.deepEqual(normalizeApiError({ error: "Invalid input.", freshness: { status: "unavailable" } }, 400), {
    error: "Invalid input.",
    freshness: { status: "unavailable" },
    code: "BAD_REQUEST",
    retryable: false,
  });
});

test("explicit error metadata is preserved when valid", () => {
  assert.deepEqual(apiErrorPayload("Provider failed.", 502, { code: "PROVIDER_UNAVAILABLE", retryable: true, details: { provider: "weather" } }), {
    error: "Provider failed.",
    code: "PROVIDER_UNAVAILABLE",
    retryable: true,
    details: { provider: "weather" },
  });
});
