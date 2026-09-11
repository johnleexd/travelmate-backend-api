import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

declare global {
  var travelmatePrisma: PrismaClient | undefined;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required. Use the pooled Neon connection string.");

// Express runs in a long-lived Node.js process, so use PostgreSQL's native TCP
// driver. The Neon serverless adapter relies on WebSockets, which can be
// unavailable in local Windows/network environments even when PostgreSQL itself
// is reachable (Prisma Migrate, for example, still connects successfully).
const adapter = new PrismaPg({ connectionString });
export const prisma = global.travelmatePrisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") global.travelmatePrisma = prisma;
