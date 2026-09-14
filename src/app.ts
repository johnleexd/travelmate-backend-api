import express from "express";
import cors from "cors";
import {
  allowedOrigins,
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

const app = express();
const trustedOrigins = allowedOrigins();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(securityHeaders());
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || trustedOrigins.includes(origin.replace(/\/$/, "")));
  },
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api", sameOriginWrites(trustedOrigins));
app.use("/api", disableApiCaching);
app.use(systemRoutes);
app.use("/api", apiRoutes);
app.use("/api", apiNotFound);
app.use(errorHandler);

export default app;
