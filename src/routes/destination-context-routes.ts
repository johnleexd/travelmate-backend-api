import { Router } from 'express';
import { GET, GET_EXCHANGE_RATE } from '../controllers/destination-context-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';

const destinationContextRoutes = Router();
destinationContextRoutes.get('/', adaptWebHandler(GET));
destinationContextRoutes.get('/exchange-rate', adaptWebHandler(GET_EXCHANGE_RATE));

export default destinationContextRoutes;
