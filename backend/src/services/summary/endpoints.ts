import groupBy from "lodash/groupBy"
import { In } from "typeorm"
import { ApiEndpoint, ApiTrace } from "models"
import { EndpointAndUsage } from "@common/types"
import { DatabaseService } from "services/database"
import { MetloContext } from "types"
import { RedisClient } from "utils/redis"
import { getRepository } from "services/database/utils"
import mlog from "logger"

export const getTopEndpoints = async (ctx: MetloContext) => {
  const apiTraceRepository = getRepository(ctx, ApiTrace)
  const apiEndpointRepository = getRepository(ctx, ApiEndpoint)

  const startEndpointStats = performance.now()
  const endpointStats: {
    endpoint: string
    last1MinCnt: number
    last5MinCnt: number
    last30MinCnt: number
  }[] = await DatabaseService.executeRawQuery(`
    SELECT
      traces."apiEndpointUuid" as endpoint,
      CAST(COUNT(*) AS INTEGER) as "last30MinCnt",
      CAST(SUM(CASE WHEN traces."createdAt" > (NOW() - INTERVAL '5 minutes') THEN 1 ELSE 0 END) AS INTEGER) as "last5MinCnt",
      CAST(SUM(CASE WHEN traces."createdAt" > (NOW() - INTERVAL '1 minutes') THEN 1 ELSE 0 END) AS INTEGER) as "last1MinCnt"
    FROM
      ${ApiTrace.getTableName(ctx)} traces
    WHERE
      traces."apiEndpointUuid" IS NOT NULL
      AND traces."createdAt" > (NOW() - INTERVAL '30 minutes')
    GROUP BY 1
    ORDER BY 4 DESC
    LIMIT 10
  `)
  mlog.time(
    "backend.get_top_endpoints.endpoint_stats",
    performance.now() - startEndpointStats,
  )

  const endpointsStart = performance.now()
  const endpoints = await apiEndpointRepository.find({
    where: { uuid: In(endpointStats.map(e => e.endpoint)) },
  })
  mlog.time(
    "backend.get_top_endpoints.endpoints",
    performance.now() - endpointsStart,
  )

  const tracesStart = performance.now()
  const traces = await Promise.all(
    endpointStats.map(e =>
      apiTraceRepository.find({
        select: {
          uuid: true,
          path: true,
          responseStatus: true,
          createdAt: true,
          // @ts-ignore
          meta: true,
          apiEndpointUuid: true,
        },
        where: { apiEndpointUuid: e.endpoint },
        order: { createdAt: "DESC" },
        take: 25,
      }),
    ),
  )
  mlog.time("backend.get_top_endpoints.traces", performance.now() - tracesStart)
  const traceMap = groupBy(traces.flat(), e => e.apiEndpointUuid)

  return endpointStats.map(
    stats =>
      ({
        ...endpoints.find(e => e.uuid == stats.endpoint),
        last30MinCnt: stats.last30MinCnt,
        last5MinCnt: stats.last5MinCnt,
        last1MinCnt: stats.last1MinCnt,
        traces: traceMap[stats.endpoint],
        tests: [],
      } as EndpointAndUsage),
  )
}

export const getTopEndpointsCached = async (ctx: MetloContext) => {
  const cacheRes: EndpointAndUsage[] | null = await RedisClient.getFromRedis(
    ctx,
    "endpointUsageStats",
  )
  if (cacheRes) {
    return cacheRes
  }
  const start = performance.now()
  const realRes = await getTopEndpoints(ctx)
  mlog.time("backend.get_top_endpoints", performance.now() - start)
  await RedisClient.addToRedis(ctx, "endpointUsageStats", realRes, 15)
  return realRes
}
