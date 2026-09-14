import { Router } from "express";
import { POST } from "../controllers/itinerary-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const itineraryRoutes = Router();
itineraryRoutes.post("/", adaptWebHandler(POST));

export default itineraryRoutes;
