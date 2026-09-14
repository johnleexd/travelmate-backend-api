import { Router } from "express";
import { GET, POST } from "../controllers/auth-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const authRoutes = Router();
authRoutes.get("/", adaptWebHandler(GET));
authRoutes.post("/", adaptWebHandler(POST));

export default authRoutes;
