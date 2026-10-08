import { readNotificationSnapshot } from '../repositories/trip-workspace-repository.ts';
import type { RequestHandler } from 'express';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { toWebRequest } from '../middlewares/web-handler-middleware.ts';
import { prisma } from '../lib/prisma.ts';
import { publicUser } from '../schemas/domain.ts';
import { subscribeReportChanges } from '../services/platform/report-events.ts';

export const streamAdminReports: RequestHandler = async (request, response, next) => {
  const webRequest = toWebRequest(request);
  try { await requireUser(webRequest, 'admin'); }
  catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      response.status(401).json({ error: 'Unauthorized.' });
    } else next(error);
    return;
  }
  if (response.destroyed) return;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-store, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  response.write('retry: 2000\n\n');

  let closed = false;
  let running = false;
  let dirty = false;
  let previous = '';
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(rotation);
    unsubscribe();
  };
  const refresh = async () => {
    if (closed) return;
    // Serialize reads; a commit during a read must trigger another snapshot.
    if (running) { dirty = true; return; }
    running = true;
    try {
      do {
        dirty = false;
        const admin = await requireUser(webRequest, 'admin');
        const moderation = await prisma.moderation.findMany({
          where: { kind: { in: ['report', 'appeal'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const reporters = await prisma.user.findMany({
          where: { id: { in: [...new Set(moderation.map(item => item.subjectId))] } },
          select: { id: true, name: true, email: true, role: true, emailVerified: true, profileStatus: true, trustScore: true, accountStatus: true, bio: true, phone: true, avatarUrl: true, createdAt: true },
          orderBy: { id: 'asc' },
        });
        const notifications = await readNotificationSnapshot(admin);
        const snapshot = JSON.stringify({ moderation, reporters: reporters.map(publicUser), ...notifications });
        if (closed) return;
        if (response.writableLength > 1_048_576) { cleanup(); response.end(); return; }
        if (snapshot !== previous) {
          previous = snapshot;
          response.write('event: reports\ndata: ' + snapshot + '\n\n');
        } else response.write(': heartbeat\n\n');
      } while (dirty && !closed);
    } catch (error) {
      if (!closed) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') response.write('event: session-expired\ndata: {}\n\n');
        cleanup(); response.end();
      }
    } finally { running = false; }
  };
  const unsubscribe = subscribeReportChanges(() => { void refresh(); });
  // Reconcile writes made by other API instances as well as local commit events.
  const timer = setInterval(() => { void refresh(); }, 5000);
  // Rotate before upstream proxy timeouts. EventSource reconnects with a fresh snapshot.
  const rotation = setTimeout(() => { cleanup(); response.end(); }, 300_000);
  response.on('close', cleanup);
  void refresh();
};
