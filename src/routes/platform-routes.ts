import { Router } from "express";
import { GET, POST } from "../controllers/platform-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const platformRoutes = Router();
platformRoutes.get("/", adaptWebHandler(GET));
platformRoutes.post("/", adaptWebHandler(POST));

export default platformRoutes;
