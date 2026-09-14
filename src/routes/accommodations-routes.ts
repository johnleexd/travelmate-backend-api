import { Router } from "express";
import { GET } from "../controllers/accommodations-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const accommodationsRoutes = Router();
accommodationsRoutes.get("/", adaptWebHandler(GET));

export default accommodationsRoutes;
