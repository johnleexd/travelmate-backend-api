import { GET_ACTIVITIES, PATCH_ACTIVITY, POST_REPLAN, POST_ACCEPT_DAY } from '../controllers/smart-itinerary-controller.ts';
import { POST_SAVED_ACTIVITY_PHOTOS } from '../controllers/activity-photo-controller.ts';
import { streamAdminReports } from '../controllers/admin-reports-stream.ts';
import { Router } from "express";
import { GET_ACTIVITY_LOG } from '../controllers/activity-log-controller.ts';
import { GET, POST, GET_NOTIFICATIONS, GET_TRIP, GET_VERSIONS, GET_VISITED_PLACES, GET_TRIP_VISIT_CANDIDATES } from "../controllers/platform-controller.ts";
import { adaptWebHandler } from "../middlewares/web-handler-middleware.ts";

const platformRoutes = Router();
platformRoutes.get('/reports/stream', streamAdminReports);
platformRoutes.get('/activity', adaptWebHandler(GET_ACTIVITY_LOG));
platformRoutes.get("/", adaptWebHandler(GET));
platformRoutes.post("/", adaptWebHandler(POST));
platformRoutes.get('/notifications', adaptWebHandler(GET_NOTIFICATIONS));
platformRoutes.get('/visited-places', adaptWebHandler(GET_VISITED_PLACES));
platformRoutes.get('/trips/:id/visit-candidates', adaptWebHandler(GET_TRIP_VISIT_CANDIDATES));
platformRoutes.get('/trips/:id/activities', adaptWebHandler(GET_ACTIVITIES));
platformRoutes.post('/trips/:id/photos', adaptWebHandler(POST_SAVED_ACTIVITY_PHOTOS));
platformRoutes.patch('/trips/:id/activities/:activityId', adaptWebHandler(PATCH_ACTIVITY));
platformRoutes.post('/trips/:id/replan', adaptWebHandler(POST_REPLAN));
platformRoutes.post('/trips/:id/replan/accept', adaptWebHandler(POST_ACCEPT_DAY));
platformRoutes.get('/trips/:id', adaptWebHandler(GET_TRIP));
platformRoutes.get('/trips/:id/versions', adaptWebHandler(GET_VERSIONS));

export default platformRoutes;
