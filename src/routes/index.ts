import { Router } from "express";
import accommodationsRoutes from "./accommodations-routes.ts";
import authRoutes from "./auth-routes.ts";
import itineraryRoutes from "./itinerary-routes.ts";
import locationsRoutes from "./locations-routes.ts";
import platformRoutes from "./platform-routes.ts";
import profileRoutes from "./profile-routes.ts";
import travelOptionsRoutes from "./travel-options-routes.ts";
import weatherRoutes from "./weather-routes.ts";

const apiRoutes = Router();
apiRoutes.use("/auth", authRoutes);
apiRoutes.use("/platform", platformRoutes);
apiRoutes.use("/itinerary", itineraryRoutes);
apiRoutes.use("/weather", weatherRoutes);
apiRoutes.use("/locations", locationsRoutes);
apiRoutes.use("/accommodations", accommodationsRoutes);
apiRoutes.use("/travel-options", travelOptionsRoutes);
apiRoutes.use("/profile", profileRoutes);

export default apiRoutes;
