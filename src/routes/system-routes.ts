import { Router } from "express";
import { apiInformation, healthCheck, livenessCheck } from "../controllers/system-controller.ts";
import { disableApiCaching } from "../middlewares/http-middleware.ts";

const systemRoutes = Router();
systemRoutes.get("/", apiInformation);
systemRoutes.get("/health", disableApiCaching, healthCheck);
systemRoutes.get("/health/live", disableApiCaching, livenessCheck);

export default systemRoutes;
