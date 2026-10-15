import { GET_TRIP_MAP, POST_TRIP_ACTIVITY, POST_TRIP_DAY_ROUTE, POST_TRIP_ACTIVITY_WEATHER } from '../controllers/trip-navigation-controller.ts';
import { Router } from 'express';
import { POST_ROUTE, POST_SEARCH } from '../controllers/navigation-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';

const navigationRoutes = Router();
navigationRoutes.post('/search', adaptWebHandler(POST_SEARCH));
navigationRoutes.post('/route', adaptWebHandler(POST_ROUTE));
navigationRoutes.get('/trips/:id/map', adaptWebHandler(GET_TRIP_MAP));
navigationRoutes.post('/trips/:id/activity', adaptWebHandler(POST_TRIP_ACTIVITY));
navigationRoutes.post('/trips/:id/day-route', adaptWebHandler(POST_TRIP_DAY_ROUTE));
navigationRoutes.post('/trips/:id/weather', adaptWebHandler(POST_TRIP_ACTIVITY_WEATHER));

export default navigationRoutes;
