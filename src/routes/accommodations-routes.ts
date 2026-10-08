import { Router } from "express";
import { POST } from "../controllers/accommodation-check-controller.ts";
import { GET } from "../controllers/accommodations-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const accommodationsRoutes = Router();
accommodationsRoutes.post("/revalidate", adaptWebHandler(POST));
accommodationsRoutes.get("/", adaptWebHandler(GET));

export default accommodationsRoutes;
