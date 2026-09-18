import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Validates requests from Google Cloud Scheduler or authorized external cron runners.
 *
 * Requirements:
 * - Reads SCHEDULER_SECRET from server-side environment variables.
 * - Compares securely using crypto.timingSafeEqual to mitigate timing attacks.
 * - Never leaks secret in errors, headers, or logs.
 * - Accepts secret via:
 *   1. Authorization: Bearer <SCHEDULER_SECRET>
 *   2. X-Scheduler-Secret: <SCHEDULER_SECRET>
 *   3. ?secret=<SCHEDULER_SECRET> (as query param fallback for simple webhook runners)
 */
export function requireSchedulerAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.SCHEDULER_SECRET;

  if (!configuredSecret || configuredSecret.trim().length < 16) {
    console.error("[SchedulerAuth] SCHEDULER_SECRET environment variable is missing or insufficiently long (min 16 chars).");
    res.status(500).json({
      error: "Scheduler endpoint authentication is not configured on the server.",
      detail: "SCHEDULER_SECRET must be set in server environment variables.",
    });
    return;
  }

  // Extract candidate token from Authorization header (Bearer), X-Scheduler-Secret header, or query param
  let candidateToken: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      candidateToken = parts[1];
    }
  }

  if (!candidateToken && req.headers["x-scheduler-secret"]) {
    const rawHeader = req.headers["x-scheduler-secret"];
    if (typeof rawHeader === "string") {
      candidateToken = rawHeader.trim();
    }
  }

  if (!candidateToken && req.query && typeof req.query.secret === "string") {
    candidateToken = req.query.secret.trim();
  }

  if (!candidateToken) {
    res.status(401).json({
      error: "Unauthorized scheduler invocation.",
      detail: "Missing authorization credentials. Provide Bearer token or X-Scheduler-Secret header.",
    });
    return;
  }

  try {
    const expectedBuffer = Buffer.from(configuredSecret, "utf-8");
    const candidateBuffer = Buffer.from(candidateToken, "utf-8");

    if (expectedBuffer.length !== candidateBuffer.length) {
      res.status(401).json({
        error: "Unauthorized scheduler invocation.",
        detail: "Invalid scheduler authentication token.",
      });
      return;
    }

    const matches = crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
    if (!matches) {
      res.status(401).json({
        error: "Unauthorized scheduler invocation.",
        detail: "Invalid scheduler authentication token.",
      });
      return;
    }

    next();
  } catch (err: any) {
    console.error("[SchedulerAuth] Authentication verification error:", err?.message);
    res.status(401).json({
      error: "Unauthorized scheduler invocation.",
      detail: "Invalid scheduler authentication token.",
    });
  }
}
