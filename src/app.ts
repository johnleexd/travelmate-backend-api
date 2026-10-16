import express from "express";
import cors from "cors";
import {
  allowedOrigins,
  enforceHttps,
  sameOriginWrites,
  securityHeaders,
} from "./middlewares/security-middleware.ts";
import {
  apiNotFound,
  disableApiCaching,
  errorHandler,
} from "./middlewares/http-middleware.ts";
import apiRoutes from "./routes/index.ts";
import systemRoutes from "./routes/system-routes.ts";
import { requestLogging } from "./middlewares/request-logging-middleware.ts";
import paymongoWebhookRoutes from './routes/paymongo-webhook-routes.ts';

const app = express();
const trustedOrigins = allowedOrigins();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(requestLogging);
app.use(enforceHttps());
app.use(securityHeaders());
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || trustedOrigins.includes(origin.replace(/\/$/, "")));
  },
  credentials: true,
}));
// Provider signatures require the original bytes, before JSON parsing and the
// browser-only origin guard. This route has its own test-mode/signature guards.
app.use('/api/webhooks/paymongo', paymongoWebhookRoutes);
app.use(express.json({ limit: "12mb" }));
app.use("/api", sameOriginWrites(trustedOrigins));
app.use("/api", disableApiCaching);
app.use(systemRoutes);
app.use("/api", apiRoutes);
app.use("/api", apiNotFound);
app.use(errorHandler);

export default app;
