import { Router } from "express";
import { POST, POST_IMAGES } from "../controllers/itinerary-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";
import { POST_RETRY_DAYS } from '../controllers/incomplete-day-controller.ts';

const itineraryRoutes = Router();
itineraryRoutes.post("/", adaptWebHandler(POST));
itineraryRoutes.post("/images", adaptWebHandler(POST_IMAGES));
itineraryRoutes.post('/retry-days', adaptWebHandler(POST_RETRY_DAYS));

export default itineraryRoutes;
