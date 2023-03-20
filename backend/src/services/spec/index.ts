import mlog from "logger"
import { v4 as uuidv4 } from "uuid"
import { QueryRunner, Raw } from "typeorm"
import SwaggerParser from "@apidevtools/swagger-parser"
import Converter from "swagger2openapi"
import yaml from "js-yaml"
import YAML from "yaml"
import AdmZip from "adm-zip"
import OpenAPIResponseValidator, {
  OpenAPIResponseValidatorValidationError,
} from "@leoscope/openapi-response-validator"
import { RestMethod, RiskScore, SpecExtension } from "@common/enums"
import {
  ApiEndpoint,
  ApiTrace,
  DataField,
  OpenApiSpec,
  Alert,
  AggregateTraceDataHourly,
  ApiEndpointTest,
  Attack,
} from "models"
import {
  JSONValue,
  OpenApiSpec as OpenApiSpecResponse,
  QueuedApiTrace,
} from "@common/types"
import { AppDataSource } from "data-source"
import { getPathRegex, getValidPath, parsedJsonNonNull } from "utils"
import Error409Conflict from "errors/error-409-conflict"
import Error422UnprocessableEntity from "errors/error-422-unprocessable-entity"
import {
  generateAlertMessageFromRespErrors,
  getOpenAPISpecVersion,
  getSpecResponses,
  AjvError,
  getHostsV3,
  getServersV3,
  getSpecPathString,
  getParameters,
  getDataFieldsForParameters,
  getDataFieldsForRequestBody,
  getDataFieldsForResponse,
} from "./utils"
import Error404NotFound from "errors/error-404-not-found"
import Error500InternalServer from "errors/error-500-internal-server"
import {
  insertAggregateHourlyQuery,
  deleteOpenAPISpecDiffAlerts,
  updateOldEndpointUuids,
  getAllOldEndpoints,
} from "./queries"
import { MetloContext } from "types"
import {
  getEntityManager,
  getQB,
  getRepository,
  insertValuesBuilder,
} from "services/database/utils"
import Error400BadRequest from "errors/error-400-bad-request"
import { createSpecDiffAlerts } from "services/alert/openapi-spec"
import { BlockFieldsService } from "services/block-fields"

interface EndpointsMap {
  endpoint: ApiEndpoint
  similarEndpoints: Record<string, ApiEndpoint>
  specPath: string
  specMethod: string
}

export class SpecService {
  static async getSpecZip(ctx: MetloContext) {
    const specs = await getRepository(ctx, OpenApiSpec).find({
      select: {
        name: true,
        spec: true,
        extension: true,
      },
    })
    const zip = new AdmZip()
    if (specs.length === 0) {
      throw new Error500InternalServer("No OpenAPI Specs found.")
    }
    for (const spec of specs) {
      const encodedName = encodeURIComponent(spec.name)
      zip.addFile(
        `${encodedName}.${spec.extension}`,
        Buffer.alloc(spec.spec.length, spec.spec),
      )
    }
    return zip.toBuffer()
  }

  static async getSpec(
    ctx: MetloContext,
    specName: string,
  ): Promise<OpenApiSpecResponse> {
    const openApiSpecRepository = getRepository(ctx, OpenApiSpec)
    const spec = await openApiSpecRepository.findOneBy({ name: specName })
    return spec
  }

  static async getSpecs(ctx: MetloContext): Promise<OpenApiSpecResponse[]> {
    const openApiSpecRepository = getRepository(ctx, OpenApiSpec)
    const specList = await openApiSpecRepository.find({
      select: {
        name: true,
        hosts: true,
        createdAt: true,
        updatedAt: true,
        specUpdatedAt: true,
        isAutoGenerated: true,
      },
      order: { isAutoGenerated: "ASC", specUpdatedAt: "DESC" },
    })
    return specList
  }

  static async updateSpec(
    ctx: MetloContext,
    specObject: any,
    fileName: string,
    extension: SpecExtension,
    specString: string,
  ): Promise<void> {
    const specVersion = getOpenAPISpecVersion(specObject)
    if (!specVersion) {
      throw new Error422UnprocessableEntity(
        "Invalid OpenAPI Spec: No 'swagger' or 'openapi' field defined.",
      )
    }
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      await this.deleteSpec(ctx, fileName, queryRunner)
      await this.uploadNewSpec(
        ctx,
        specObject,
        fileName,
        extension,
        specString,
        queryRunner,
      )
      await queryRunner.commitTransaction()
    } catch (err) {
      mlog.withErr(err).error("Error updating spec file")
      await queryRunner.rollbackTransaction()
      throw err
    } finally {
      await queryRunner.release()
    }
  }

  static async deleteSpec(
    ctx: MetloContext,
    fileName: string,
    existingQueryRunner?: QueryRunner,
  ): Promise<void> {
    let queryRunner: QueryRunner
    if (existingQueryRunner) {
      queryRunner = existingQueryRunner
    } else {
      queryRunner = AppDataSource.createQueryRunner()
      await queryRunner.connect()
      await queryRunner.startTransaction()
    }
    try {
      const openApiSpec = await getEntityManager(ctx, queryRunner).findOneBy(
        OpenApiSpec,
        {
          name: fileName,
        },
      )
      if (!openApiSpec) {
        throw new Error404NotFound(
          "No spec file with the provided name exists.",
        )
      }
      if (openApiSpec.isAutoGenerated) {
        throw new Error409Conflict("Can't delete auto generated spec.")
      }
      await queryRunner.query(deleteOpenAPISpecDiffAlerts(ctx), [fileName])
      await getQB(ctx, queryRunner)
        .update(ApiEndpoint)
        .set({ openapiSpecName: null, userSet: false })
        .andWhere('"openapiSpecName" = :name', { name: fileName })
        .execute()
      await getQB(ctx, queryRunner)
        .delete()
        .from(OpenApiSpec)
        .andWhere("name = :name", { name: fileName })
        .execute()
      if (!existingQueryRunner) {
        await queryRunner.commitTransaction()
      }
    } catch (err) {
      if (!existingQueryRunner) {
        mlog.withErr(err).error("Error deleting spec file")
        await queryRunner.rollbackTransaction()
      }
      throw err
    } finally {
      if (!existingQueryRunner) {
        await queryRunner.release()
      }
    }
  }

  static async uploadNewSpec(
    ctx: MetloContext,
    specObject: any,
    fileName: string,
    extension: SpecExtension,
    specString: string,
    existingQueryRunner?: QueryRunner,
  ): Promise<void> {
    const currTime = new Date()
    const specVersion = getOpenAPISpecVersion(specObject)
    if (!specVersion) {
      throw new Error422UnprocessableEntity(
        "Invalid OpenAPI Spec: No 'swagger' or 'openapi' field defined.",
      )
    }

    if (specVersion === 2) {
      const convertedSpec = await Converter.convertObj(specObject, {})
      if (!convertedSpec?.openapi) {
        throw new Error500InternalServer(
          "Unable to convert swagger spec to OpenAPI V3.",
        )
      }
      specObject = convertedSpec.openapi
      if (extension === SpecExtension.YAML) {
        const doc = new YAML.Document()
        doc.contents = specObject as any
        specString = doc.toString()
      } else {
        specString = JSON.stringify(specObject, null, 2)
      }
    }

    let parsedSpec = specObject
    try {
      if (specVersion === 3.1) {
        parsedSpec = await SwaggerParser.dereference(specObject as any, {
          dereference: { circular: "ignore" },
          resolve: { file: false },
        })
      } else {
        parsedSpec = await SwaggerParser.validate(specObject as any, {
          dereference: { circular: "ignore" },
          resolve: { file: false },
        })
      }
    } catch (err) {
      throw new Error422UnprocessableEntity(
        `Invalid OpenAPI Spec: ${err.message.toString()}`,
      )
    }

    const paths: JSONValue = specObject["paths"]

    const apiEndpointRepository = existingQueryRunner
      ? getEntityManager(ctx, existingQueryRunner).manager.getRepository(
          ApiEndpoint,
        )
      : getRepository(ctx, ApiEndpoint)
    const openApiSpecRepository = existingQueryRunner
      ? getEntityManager(ctx, existingQueryRunner).manager.getRepository(
          OpenApiSpec,
        )
      : getRepository(ctx, OpenApiSpec)

    let existingSpec = await openApiSpecRepository.findOneBy({
      name: fileName,
    })
    if (!existingSpec) {
      existingSpec = new OpenApiSpec()
      existingSpec.name = fileName
      existingSpec.extension = extension
      existingSpec.createdAt = currTime
    }
    existingSpec.spec = specString
    existingSpec.specUpdatedAt = currTime
    existingSpec.updatedAt = currTime
    const pathKeys = Object.keys(paths)
    const endpointsMap: Record<string, EndpointsMap> = {}
    let specHosts: Set<string> = new Set()
    for (const path of pathKeys) {
      const validPath = getValidPath(path)
      if (!validPath.isValid) {
        throw new Error400BadRequest(`${path}: ${validPath.errMsg}`)
      }
      const validPathStringOrig = validPath.path
      const methods = Object.keys(paths[path])?.filter(key =>
        Object.values(RestMethod).includes(key.toUpperCase() as RestMethod),
      )
      for (const method of methods) {
        let hosts: Record<string, Set<string>> = {}
        const servers = getServersV3(specObject, path, method)
        if (!servers || servers?.length === 0) {
          throw new Error422UnprocessableEntity(
            "No servers or host found in spec file.",
          )
        }
        hosts = getHostsV3(servers)
        const hostKeys = Object.keys(hosts)
        specHosts = new Set([...specHosts, ...hostKeys])
        for (const host in hosts) {
          // For exact endpoint match
          const basePaths = hosts[host]
          if (basePaths.size === 0) {
            basePaths.add("")
          }
          for (const basePath of basePaths) {
            const validPathString = basePath + validPathStringOrig
            const pathRegex = getPathRegex(validPathString)
            let created = false
            let updated = false
            const methodEnum = method.toUpperCase() as RestMethod
            let apiEndpoint = await apiEndpointRepository.findOne({
              where: {
                path: validPathString,
                method: methodEnum,
                host,
              },
              relations: { openapiSpec: true },
            })
            if (!apiEndpoint) {
              apiEndpoint = new ApiEndpoint()
              apiEndpoint.uuid = uuidv4()
              apiEndpoint.path = validPathString
              apiEndpoint.pathRegex = pathRegex
              apiEndpoint.method = methodEnum
              apiEndpoint.host = host
              apiEndpoint.openapiSpec = existingSpec
              apiEndpoint.addNumberParams()
              apiEndpoint.riskScore = RiskScore.NONE
              created = true
            } else if (
              apiEndpoint &&
              (!apiEndpoint.openapiSpecName ||
                apiEndpoint.openapiSpec?.isAutoGenerated)
            ) {
              apiEndpoint.openapiSpec = existingSpec
              apiEndpoint.openapiSpecName = existingSpec.name
              updated = true
            } else {
              throw new Error409Conflict(
                `Path ${apiEndpoint.path} defined in the given new spec file is already defined in another user defined spec file: ${apiEndpoint.openapiSpecName}`,
              )
            }
            endpointsMap[apiEndpoint.uuid] = {
              endpoint: apiEndpoint,
              similarEndpoints: {},
              specPath: path,
              specMethod: method,
            }

            const similarEndpoints = await apiEndpointRepository.find({
              where: {
                path: Raw(alias => `${alias} ~ :pathRegex`, { pathRegex }),
                method: methodEnum,
                host,
              },
            })
            similarEndpoints.forEach(item => {
              let exists = false
              if (!endpointsMap[item.uuid]) {
                Object.keys(endpointsMap).forEach(uuid => {
                  if (endpointsMap[uuid]?.similarEndpoints?.[item.uuid]) {
                    exists = true
                    if (
                      apiEndpoint.numberParams === item.numberParams ||
                      (endpointsMap[uuid].endpoint?.numberParams !==
                        item.numberParams &&
                        apiEndpoint.numberParams <
                          endpointsMap[uuid].endpoint?.numberParams)
                    ) {
                      delete endpointsMap[uuid].similarEndpoints[item.uuid]
                      exists = false
                    }
                  }
                })
              } else {
                exists = true
              }
              if (!exists) {
                endpointsMap[apiEndpoint.uuid].similarEndpoints[item.uuid] =
                  item
              }
            })
            if (updated) {
              Object.keys(endpointsMap).forEach(uuid => {
                if (endpointsMap[uuid]?.similarEndpoints?.[apiEndpoint.uuid]) {
                  delete endpointsMap[uuid]?.similarEndpoints[apiEndpoint.uuid]
                }
              })
            }
          }
        }
      }
    }
    existingSpec.hosts = [...specHosts]

    let queryRunner: QueryRunner
    if (existingQueryRunner) {
      queryRunner = existingQueryRunner
    } else {
      queryRunner = AppDataSource.createQueryRunner()
      await queryRunner.connect()
      await queryRunner.startTransaction()
    }

    try {
      await getEntityManager(ctx, queryRunner).save(existingSpec)
      for (const item of Object.values(endpointsMap)) {
        item.endpoint.userSet = true
        await getEntityManager(ctx, queryRunner).save(item.endpoint)
        const similarEndpointUuids = []
        for (const e of Object.values(item.similarEndpoints)) {
          similarEndpointUuids.push(e.uuid)
          item.endpoint.updateDates(e.firstDetected)
          item.endpoint.updateDates(e.lastActive)
        }

        if (similarEndpointUuids.length > 0) {
          await getEntityManager(ctx, queryRunner).save(item.endpoint)
          const updateTracesQb = getQB(ctx, queryRunner)
            .update(ApiTrace)
            .set({ apiEndpointUuid: item.endpoint.uuid })
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteAttacksQb = getQB(ctx, queryRunner)
            .delete()
            .from(Attack)
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteEndpointTestsQb = getQB(ctx, queryRunner)
            .delete()
            .from(ApiEndpointTest)
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteDataFieldsQb = getQB(ctx, queryRunner)
            .delete()
            .from(DataField)
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteAlertsQb = getQB(ctx, queryRunner)
            .delete()
            .from(Alert)
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteAggregateHourlyQb = getQB(ctx, queryRunner)
            .delete()
            .from(AggregateTraceDataHourly)
            .andWhere(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const oldEndpointUuids =
            (
              await queryRunner.query(getAllOldEndpoints(ctx), [
                similarEndpointUuids,
              ])
            )?.[0]?.uuids ?? []
          const concatUuids =
            oldEndpointUuids.length > 0
              ? similarEndpointUuids?.concat(oldEndpointUuids)
              : similarEndpointUuids

          await updateTracesQb.execute()
          await queryRunner.query(updateOldEndpointUuids, [
            concatUuids,
            item.endpoint.uuid,
          ])
          await deleteEndpointTestsQb.execute()
          await deleteAttacksQb.execute()
          await deleteDataFieldsQb.execute()
          await deleteAlertsQb.execute()
          await queryRunner.query(insertAggregateHourlyQuery(ctx), [
            item.endpoint.uuid,
            similarEndpointUuids,
          ])
          await deleteAggregateHourlyQb.execute()
          await getQB(ctx, queryRunner)
            .delete()
            .from(ApiEndpoint)
            .andWhere(`"uuid" IN(:...ids)`, { ids: similarEndpointUuids })
            .execute()
        }

        // Generate DataFields based on spec
        const parameters = getParameters(
          parsedSpec,
          item.specPath,
          item.specMethod,
        )
        const parameterDataFields = getDataFieldsForParameters(
          parameters,
          item.endpoint.uuid,
        )
        const requestBodyDataFields = getDataFieldsForRequestBody(
          parsedSpec,
          item.specPath,
          item.specMethod,
          item.endpoint.uuid,
        )
        const responseDataFields = getDataFieldsForResponse(
          parsedSpec,
          item.specPath,
          item.specMethod,
          item.endpoint.uuid,
        )
        const dataFields = parameterDataFields
          .concat(requestBodyDataFields)
          .concat(responseDataFields)
        await insertValuesBuilder(ctx, queryRunner, DataField, dataFields)
          .orUpdate(
            ["dataType", "isNullable"],
            [
              "dataSection",
              "dataPath",
              "apiEndpointUuid",
              "statusCode",
              "contentType",
            ],
          )
          .execute()
      }
      if (!existingQueryRunner) {
        await queryRunner.commitTransaction()
      }
    } catch (err) {
      if (!existingQueryRunner) {
        mlog.withErr(err).error("Error updating database for spec upload")
        await queryRunner.rollbackTransaction()
      }
      throw new Error500InternalServer(err)
    } finally {
      if (!existingQueryRunner) {
        await queryRunner.release()
      }
    }
  }

  static async findOpenApiSpecDiff(
    ctx: MetloContext,
    trace: QueuedApiTrace,
    endpoint: ApiEndpoint,
    queryRunner: QueryRunner,
    redact: boolean,
  ): Promise<Alert[]> {
    try {
      if (
        !endpoint.openapiSpecName ||
        endpoint.openapiSpecName.endsWith("-generated")
      ) {
        return []
      }
      const openApiSpec = await getEntityManager(ctx, queryRunner).findOneBy(
        OpenApiSpec,
        {
          name: endpoint.openapiSpecName,
        },
      )
      if (!openApiSpec || openApiSpec?.isAutoGenerated) {
        return []
      }
      const specObject: JSONValue = yaml.load(openApiSpec.spec) as JSONValue
      const parsedSpec = await SwaggerParser.dereference(specObject as any)
      const pathString = getSpecPathString(parsedSpec, endpoint.path)

      // Validate response info
      let respErrorItems = {}
      if (pathString) {
        const blockField = await BlockFieldsService.getBlockFieldsEntry(
          ctx,
          trace,
        )
        const responses = getSpecResponses(parsedSpec, endpoint, pathString)
        const responseValidator = new OpenAPIResponseValidator({
          components: specObject["components"],
          responses: responses?.value,
          errorTransformer: (error, ajvError) => {
            return ajvError
          },
        })
        const traceStatusCode = trace.responseStatus
        const resHeaders = trace.responseHeaders.reduce(
          (obj, item) => ((obj[item.name] = item.value), obj),
          {},
        )
        const traceResponseBody = parsedJsonNonNull(trace.responseBody, true)
        const responseValidationItems: OpenAPIResponseValidatorValidationError =
          responseValidator.validateResponse(
            traceStatusCode,
            traceResponseBody,
            resHeaders,
          )
        const responseErrors = responseValidationItems?.errors
        respErrorItems = generateAlertMessageFromRespErrors(
          responseErrors as AjvError[],
          responses?.path,
          blockField?.disabledPaths?.resBody ?? [],
        )
      }

      const filteredApiTrace = {
        ...trace,
      }
      if (redact) {
        filteredApiTrace.redacted = true
        filteredApiTrace.requestParameters = []
        filteredApiTrace.requestHeaders = []
        filteredApiTrace.responseHeaders = []
        filteredApiTrace.requestBody = ""
        filteredApiTrace.responseBody = ""
      }

      const errorItems = { ...respErrorItems }
      return await createSpecDiffAlerts(
        ctx,
        errorItems,
        endpoint.uuid,
        filteredApiTrace,
        openApiSpec,
        queryRunner,
      )
    } catch (err) {
      mlog.withErr(err).error("Error finding OpenAPI Spec diff")
      return []
    }
  }
}
