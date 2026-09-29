import { Router } from "express";
import { GET, GET_CURRENT } from "../controllers/locations-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const locationsRoutes = Router();
locationsRoutes.get("/current", adaptWebHandler(GET_CURRENT));
locationsRoutes.get("/", adaptWebHandler(GET));

export default locationsRoutes;
