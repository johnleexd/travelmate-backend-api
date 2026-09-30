import { Router } from 'express';
import { GET, POST } from '../controllers/appeal-controller.ts';
import { adaptWebHandler } from '../middlewares/web-handler-middleware.ts';
const router = Router();
router.get('/', adaptWebHandler(GET));
router.post('/', adaptWebHandler(POST));
export default router;
