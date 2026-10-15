import { Router } from 'express';
import { GET, GET_EXCHANGE_RATE, GET_PHOTO, POST_PHOTO_SELECTION } from '../controllers/destination-context-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';

const destinationContextRoutes = Router();
destinationContextRoutes.get('/', adaptWebHandler(GET));
destinationContextRoutes.get('/exchange-rate', adaptWebHandler(GET_EXCHANGE_RATE));
destinationContextRoutes.get('/photo', adaptWebHandler(GET_PHOTO));
destinationContextRoutes.post('/photo-selection', adaptWebHandler(POST_PHOTO_SELECTION));

export default destinationContextRoutes;
