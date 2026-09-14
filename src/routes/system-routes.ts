import { Router } from "express";
import { apiInformation, healthCheck } from "../controllers/system-controller.ts";

const systemRoutes = Router();
systemRoutes.get("/", apiInformation);
systemRoutes.get("/health", healthCheck);

export default systemRoutes;
