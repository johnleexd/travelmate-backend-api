import { Router } from 'express';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';
import { GET_PLAN, GET_OPERATION } from '../controllers/plan-controller.ts';
import { GET_CHECKOUT, POST_CHECKOUT, POST_CHECKOUT_ACTION } from '../controllers/test-checkout-controller.ts';
const routes = Router();
routes.get('/', adaptWebHandler(GET_PLAN));
routes.get('/operations/:key', adaptWebHandler(GET_OPERATION));
routes.get('/checkout', adaptWebHandler(GET_CHECKOUT));
routes.post('/checkout', adaptWebHandler(POST_CHECKOUT));
routes.post('/checkouts/:id/verify', adaptWebHandler(POST_CHECKOUT_ACTION));
routes.post('/checkouts/:id/cancel', adaptWebHandler(POST_CHECKOUT_ACTION));
// Test checkout is authenticated; redirects and browser values never grant Plus.
export default routes;
