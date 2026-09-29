import { Router } from "express";
import { POST, POST_IMAGES } from "../controllers/itinerary-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const itineraryRoutes = Router();
itineraryRoutes.post("/", adaptWebHandler(POST));
itineraryRoutes.post("/images", adaptWebHandler(POST_IMAGES));

export default itineraryRoutes;
