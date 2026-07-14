import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { DashboardStats } from './stats.schema.js';

export interface StatsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface StatsService {
  dashboard(): Promise<DashboardStats>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function makeStatsService({ prisma }: StatsDeps): StatsService {
  return {
    async dashboard() {
      const now = Date.now();
      const weekAgo = new Date(now - 7 * DAY_MS);
      const monthAgo = new Date(now - 30 * DAY_MS);

      const live = { deletedAt: null };

      // One transaction so every count reflects the same snapshot — a cadre created
      // mid-read must not land in the total but not the category breakdown. Plain
      // counts (not groupBy): only three categories and two origins, and each is a
      // cheap indexed count, so the extra round-trips are negligible at this scale.
      const [
        surrenderedTotal,
        surrenderedDistrict,
        surrenderedOther,
        thana,
        jail,
        activeAlerts,
        reportsThisWeek,
        pendingReporting,
      ] = await prisma.$transaction([
        prisma.cadre.count({ where: { ...live, category: 'surrendered' } }),
        prisma.cadre.count({ where: { ...live, category: 'surrendered', surrenderOrigin: 'district' } }),
        prisma.cadre.count({ where: { ...live, category: 'surrendered', surrenderOrigin: 'other' } }),
        prisma.cadre.count({ where: { ...live, category: 'thana' } }),
        prisma.cadre.count({ where: { ...live, category: 'jail' } }),
        prisma.cadre.count({ where: { ...live, alertLevel: 'critical' } }),
        prisma.report.count({ where: { ...live, reportedAt: { gte: weekAgo } } }),
        // Cadres with no live report in the last 30 days — the "overdue on the monthly
        // check-in" count. `none` covers never-reported too (an empty relation matches).
        prisma.cadre.count({
          where: { ...live, reports: { none: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
        }),
      ]);

      return {
        // The three categories partition every live cadre, so their sum is the total.
        totalCadres: surrenderedTotal + thana + jail,
        activeAlerts,
        reportsThisWeek,
        pendingReporting,
        byCategory: {
          // A surrendered cadre with a NULL origin (ADR-019) is invisible to both
          // tiles: it counts toward `total` but neither `district` nor `other`, so the
          // two need not sum to the total. That gap is the unclassified set.
          surrendered: { district: surrenderedDistrict, other: surrenderedOther, total: surrenderedTotal },
          thana,
          jail,
        },
      };
    },
  };
}
