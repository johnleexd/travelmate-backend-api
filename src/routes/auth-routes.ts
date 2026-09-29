import { Router } from "express";
import { GET, POST } from "../controllers/auth-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";
import { GOOGLE_CALLBACK, GOOGLE_START, GOOGLE_STATUS } from '../controllers/google-oauth-controller.ts';

const authRoutes = Router();
authRoutes.get("/", adaptWebHandler(GET));
authRoutes.post("/", adaptWebHandler(POST));
authRoutes.get('/oauth/google/status', adaptWebHandler(GOOGLE_STATUS));
authRoutes.get('/oauth/google', adaptWebHandler(GOOGLE_START));
authRoutes.get('/oauth/google/callback', adaptWebHandler(GOOGLE_CALLBACK));

export default authRoutes;
