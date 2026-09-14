import { Router } from "express";
import { GET } from "../controllers/weather-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const weatherRoutes = Router();
weatherRoutes.get("/", adaptWebHandler(GET));

export default weatherRoutes;
