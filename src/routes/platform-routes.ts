import { streamAdminReports } from '../controllers/admin-reports-stream.ts';
import { Router } from "express";
import { GET, POST, GET_NOTIFICATIONS, GET_TRIP, GET_VERSIONS, GET_VISITED_PLACES } from "../controllers/platform-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const platformRoutes = Router();
platformRoutes.get('/reports/stream', streamAdminReports);
platformRoutes.get("/", adaptWebHandler(GET));
platformRoutes.post("/", adaptWebHandler(POST));
platformRoutes.get('/notifications', adaptWebHandler(GET_NOTIFICATIONS));
platformRoutes.get('/visited-places', adaptWebHandler(GET_VISITED_PLACES));
platformRoutes.get('/trips/:id', adaptWebHandler(GET_TRIP));
platformRoutes.get('/trips/:id/versions', adaptWebHandler(GET_VERSIONS));

export default platformRoutes;
