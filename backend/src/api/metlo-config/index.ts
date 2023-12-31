import { Response, Router } from "express"
import { UpdateMetloConfigParams } from "@common/types"
import {
  getGlobalFullTraceCaptureCached,
  getMetloConfig,
  updateMetloConfig,
} from "services/metlo-config"
import ApiResponseHandler from "api-response-handler"
import { MetloRequest } from "types"
import {
  cleanupStoredDataClasses,
  clearDataClassCache,
  ensureValidCustomDataClasses,
  getCombinedDataClassesCached,
} from "services/data-classes"
import Error422UnprocessableEntity from "errors/error-422-unprocessable-entity"
import { AppDataSource } from "data-source"
import { getEntityManager } from "services/database/utils"
import { ApiEndpoint, OpenApiSpec } from "models"

export const updateMetloConfigHandler = async (
  req: MetloRequest,
  res: Response,
): Promise<void> => {
  try {
    const updateMetloConfigParams: UpdateMetloConfigParams = req.body
    const currentMetloConfig = await getMetloConfig(req.ctx)
    const { success, msg, err } = await ensureValidCustomDataClasses(
      req.ctx,
      updateMetloConfigParams.configString,
    )
    if (!success) {
      await ApiResponseHandler.error(res, new Error422UnprocessableEntity(msg))
      return
    }
    await updateMetloConfig(req.ctx, updateMetloConfigParams)
    await cleanupStoredDataClasses(
      req.ctx,
      currentMetloConfig,
      updateMetloConfigParams.configString,
    )
    await clearDataClassCache(req.ctx)
    await ApiResponseHandler.success(res, null)
  } catch (err) {
    await ApiResponseHandler.error(res, err)
  }
}

export const getMetloConfigHandler = async (
  req: MetloRequest,
  res: Response,
): Promise<void> => {
  try {
    let metloConfig = await getMetloConfig(req.ctx)
    if (!metloConfig) {
      metloConfig = {
        uuid: "",
        configString: "",
      }
    }
    await ApiResponseHandler.success(res, metloConfig)
  } catch (err) {
    await ApiResponseHandler.error(res, err)
  }
}

export const getAgentConfigHandler = async (
  req: MetloRequest,
  res: Response,
): Promise<void> => {
  const queryRunner = AppDataSource.createQueryRunner()
  try {
    await queryRunner.connect()
    const dataClassInfo = await getCombinedDataClassesCached(req.ctx)
    const endpointInfo = await getEntityManager(req.ctx, queryRunner).find(
      ApiEndpoint,
      {
        select: {
          path: true,
          openapiSpecName: true,
          method: true,
          host: true,
          fullTraceCaptureEnabled: true,
          numberParams: true,
          isGraphQl: true,
        },
      },
    )
    const specInfo = await getEntityManager(req.ctx, queryRunner).find(
      OpenApiSpec,
      {
        select: {
          name: true,
          spec: true,
        },
        where: { isAutoGenerated: false },
      },
    )
    const globalFullTraceCapture = await getGlobalFullTraceCaptureCached(
      req.ctx,
    )
    await ApiResponseHandler.success(res, {
      sensitiveDataList: dataClassInfo,
      endpoints: endpointInfo,
      specs: specInfo,
      globalFullTraceCapture,
    })
  } catch (err) {
    await ApiResponseHandler.error(res, err)
  } finally {
    await queryRunner.release()
  }
}

export default function registerMetloConfigRoutes(router: Router) {
  router.put("/api/v1/metlo-config", updateMetloConfigHandler)
  router.get("/api/v1/metlo-config", getMetloConfigHandler)
  router.get("/api/v1/agent-config", getAgentConfigHandler)
}
