import { Router } from 'express';
import { GET, POST, ITINERARY, OWN, DETAIL } from '../controllers/feedback-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';

const feedbackRoutes = Router();
feedbackRoutes.get('/', adaptWebHandler(GET));
feedbackRoutes.post('/', adaptWebHandler(POST));
feedbackRoutes.get('/itinerary/:id', adaptWebHandler(OWN));
feedbackRoutes.get('/:id/itinerary', adaptWebHandler(ITINERARY));
feedbackRoutes.get('/:id', adaptWebHandler(DETAIL));
export default feedbackRoutes;
