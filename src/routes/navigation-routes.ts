import { Router } from 'express';
import { POST_ROUTE, POST_SEARCH } from '../controllers/navigation-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';

const navigationRoutes = Router();
navigationRoutes.post('/search', adaptWebHandler(POST_SEARCH));
navigationRoutes.post('/route', adaptWebHandler(POST_ROUTE));
export default navigationRoutes;
