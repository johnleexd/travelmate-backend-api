import { prisma } from '../lib/prisma.ts';

export function overviewDates(now = new Date()) {
  const today = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const anchor = new Date(today + 'T00:00:00Z').getTime();
  const dates = Array.from({ length: 7 }, (_, index) => new Date(anchor - (6 - index) * 86400000).toISOString().slice(0, 10));
  const tomorrow = new Date(anchor + 86400000).toISOString().slice(0, 10);
  return { dates, start: new Date(dates[0] + 'T00:00:00+08:00'), end: new Date(tomorrow + 'T00:00:00+08:00') };
}

export async function readAdminOverview(now = new Date()) {
  const { dates, start, end } = overviewDates(now);
  const [generatedPlans, feedback, rows] = await Promise.all([
    prisma.itineraryGeneration.count({ where: { status: 'completed' } }),
    prisma.feedback.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
    prisma.$queryRaw<Array<{ date: string; status: string; count: number }>>
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
              status::text AS status, COUNT(*)::int AS count
       FROM itinerary_generations
       WHERE created_at >= ${start} AND created_at < ${end}
       GROUP BY 1, 2`,
  ]);
  return {
    generatedPlans,
    averageRating: feedback._avg.rating,
    feedbackCount: feedback._count.rating,
    generationDays: dates.map(date => ({ date, completed: rows.filter(row => row.date === date && row.status === 'completed').reduce((sum, row) => sum + row.count, 0) })),
    recentCompleted: rows.filter(row => row.status === 'completed').reduce((sum, row) => sum + row.count, 0),
    recentFailed: rows.filter(row => row.status === 'failed').reduce((sum, row) => sum + row.count, 0),
    timeZone: 'Asia/Shanghai',
  };
}
