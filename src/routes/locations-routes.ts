import { Router } from "express";
import { GET } from "../controllers/locations-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const locationsRoutes = Router();
locationsRoutes.get("/", adaptWebHandler(GET));

export default locationsRoutes;
