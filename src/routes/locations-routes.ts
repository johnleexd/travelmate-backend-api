import { Router } from "express";
import { GET, GET_CURRENT, GET_RESOLVE, GET_AREAS, GET_AREA_COMPARISON } from "../controllers/locations-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const locationsRoutes = Router();
locationsRoutes.get("/areas/compare", adaptWebHandler(GET_AREA_COMPARISON));
locationsRoutes.get("/areas", adaptWebHandler(GET_AREAS));
locationsRoutes.get("/current", adaptWebHandler(GET_CURRENT));
locationsRoutes.get("/resolve", adaptWebHandler(GET_RESOLVE));
locationsRoutes.get("/", adaptWebHandler(GET));

export default locationsRoutes;
