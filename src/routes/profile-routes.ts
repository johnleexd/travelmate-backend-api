import { Router } from "express";
import { GET, PATCH } from "../controllers/profile-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const profileRoutes = Router();
profileRoutes.get("/", adaptWebHandler(GET));
profileRoutes.patch("/", adaptWebHandler(PATCH));

export default profileRoutes;
