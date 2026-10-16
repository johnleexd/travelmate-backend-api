export class PlanError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(message: string, status: number, code: string, details?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.details = details; }
}
