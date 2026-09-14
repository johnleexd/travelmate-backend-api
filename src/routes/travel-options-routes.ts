import { Router } from "express";
import { GET } from "../controllers/travel-options-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const travelOptionsRoutes = Router();
travelOptionsRoutes.get("/", adaptWebHandler(GET));

export default travelOptionsRoutes;
