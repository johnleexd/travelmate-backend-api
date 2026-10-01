import { Router } from "express";
import { GET, POST } from "../controllers/feedback-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const feedbackRoutes = Router();
feedbackRoutes.get("/", adaptWebHandler(GET));
feedbackRoutes.post("/", adaptWebHandler(POST));

export default feedbackRoutes;
