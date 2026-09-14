import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";

export function apiInformation(_request: Request, response: Response): void {
  response.json({ name: "TravelMate API", status: "ok" });
}

export async function healthCheck(_request: Request, response: Response): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("[TravelMate API] Database health check failed:", error);
    response.status(503).json({ status: "error", database: "unavailable" });
  }
}
