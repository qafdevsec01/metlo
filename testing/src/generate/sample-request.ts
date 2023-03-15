import { jsonToGraphQLQuery, EnumType } from "json-to-graphql-query"
import { DataType } from "./enums"
import { KeyValType } from "../types/test"
import { DataSection } from "./enums"
import {
  GeneratedTestRequest,
  GenTestContext,
  GenTestEndpoint,
  GenTestEndpointDataField,
} from "./types"
import { AuthType, RestMethod } from "../types/enums"
import { TemplateConfig } from "../types/resource_config"
import { getEntityMap } from "./permissions"

const getSampleValue = (dataType: DataType) => {
  switch (dataType) {
    case DataType.BOOLEAN:
      return true
    case DataType.INTEGER:
    case DataType.NUMBER:
      return Math.floor(Math.random() * (100 - 1 + 1)) + 1
    case DataType.STRING:
      return Math.random().toString(36).slice(2)
    default:
      return null
  }
}

export const addAuthToRequest = (
  gen: GeneratedTestRequest,
  ctx: GenTestContext,
): GeneratedTestRequest => {
  const authConfig = ctx.endpoint.authConfig
  if (!authConfig) {
    return gen
  }
  let env: KeyValType[] = []
  let headers: KeyValType[] = []
  const pre = ctx.prefix ? ctx.prefix + "_" : ""
  if (authConfig.authType == AuthType.BASIC) {
    headers = headers.concat({
      name: "Authorization",
      value: `Basic {{${pre}BASIC_AUTH_CRED}}`,
    })
    env.push({
      name: `${pre}BASIC_AUTH_CRED`,
      value: `{{global.${pre}BASIC_AUTH_CRED}}`,
    })
  } else if (authConfig.authType == AuthType.HEADER) {
    headers = headers.concat({
      name: authConfig.headerKey,
      value: `{{${pre}CREDENTIALS}}`,
    })
    env.push({
      name: `${pre}CREDENTIALS`,
      value: `{{global.${pre}CREDENTIALS}}`,
    })
  } else if (authConfig.authType == AuthType.JWT) {
    headers = headers.concat({
      name: authConfig.headerKey,
      value: `{{${pre}JWT}}`,
    })
    env.push({
      name: `${pre}JWT`,
      value: `{{global.${pre}JWT}}`,
    })
  } else if (authConfig.authType == AuthType.SESSION_COOKIE) {
    headers = headers.concat({
      name: authConfig.cookieName,
      value: `{{${pre}COOKIE}}`,
    })
    env.push({
      name: `${pre}COOKIE`,
      value: `{{global.${pre}COOKIE}}`,
    })
  }
  return {
    ...gen,
    req: {
      ...gen.req,
      headers: (gen.req.headers || []).concat(headers),
    },
    env: gen.env.concat(env),
  }
}

const recurseCreateBody = (
  body: any,
  mapTokens: string[],
  currTokenIndex: number,
  dataField: GenTestEndpointDataField,
  entityMap: Record<string, any>,
): any => {
  if (currTokenIndex > mapTokens.length - 1 || !mapTokens[currTokenIndex]) {
    return dataField.entity && entityMap[dataField.entity]
      ? entityMap[dataField.entity]
      : getSampleValue(dataField.dataType)
  } else {
    const currToken = mapTokens?.[currTokenIndex]
    if (currToken === "[]") {
      return [
        recurseCreateBody(
          body?.[0],
          mapTokens,
          currTokenIndex + 1,
          dataField,
          entityMap,
        ),
      ]
    } else if (currToken === "[string]") {
      return {
        ...body,
        ANY_STRING: recurseCreateBody(
          body?.["ANY_STRING"],
          mapTokens,
          currTokenIndex + 1,
          dataField,
          entityMap,
        ),
      }
    } else {
      return {
        ...body,
        [currToken]: recurseCreateBody(
          body?.[currToken],
          mapTokens,
          currTokenIndex + 1,
          dataField,
          entityMap,
        ),
      }
    }
  }
}

const getGraphQlEntityValue = (s: any): any => {
  if (typeof s !== "string") {
    return s
  }
  if (s.startsWith("ENUM.")) {
    return new EnumType(s.split("ENUM.")[1])
  }
  return s
}

const recurseCreateBodyGraphQl = (
  body: any,
  mapTokens: string[],
  currTokenIndex: number,
  dataField: GenTestEndpointDataField,
  entityMap: Record<string, any>,
): any => {
  if (currTokenIndex > mapTokens.length - 1 || !mapTokens[currTokenIndex]) {
    if (typeof body === "object") {
      return body
    }
    return dataField.entity && entityMap[dataField.entity]
      ? getGraphQlEntityValue(entityMap[dataField.entity])
      : getSampleValue(dataField.dataType)
  } else {
    let currToken = mapTokens?.[currTokenIndex]
    if (currToken.startsWith("__on_")) {
      currToken = `... on ${currToken.split("__on_")[1]}`
    } else if (currToken === "__resp") {
      return getSampleValue(DataType.STRING)
    }

    if (currToken === "[]") {
      if (dataField.dataSection === DataSection.RESPONSE_BODY) {
        return recurseCreateBodyGraphQl(
          body,
          mapTokens,
          currTokenIndex + 1,
          dataField,
          entityMap,
        )
      } else {
        return [
          recurseCreateBodyGraphQl(
            body?.[0],
            mapTokens,
            currTokenIndex + 1,
            dataField,
            entityMap,
          ),
        ]
      }
    } else {
      return {
        ...body,
        [currToken]: recurseCreateBodyGraphQl(
          body?.[currToken],
          mapTokens,
          currTokenIndex + 1,
          dataField,
          entityMap,
        ),
      }
    }
  }
}

const getDataFieldInfo = (dataFields: GenTestEndpointDataField[]) => {
  return dataFields[dataFields.length - 1].contentType
}

const addBodyToRequest = (
  gen: GeneratedTestRequest,
  ctx: GenTestContext,
): GeneratedTestRequest => {
  const endpoint = ctx.endpoint
  const dataFields = endpoint.dataFields.filter(
    e =>
      (endpoint.isGraphQl
        ? (e.dataSection === DataSection.REQUEST_BODY ||
            (e.dataSection === DataSection.RESPONSE_BODY &&
              endpoint.method !== RestMethod.GET)) &&
          e.dataType !== DataType.UNKNOWN
        : e.dataSection === DataSection.REQUEST_BODY) && e.contentType,
  )
  if (dataFields.length == 0) {
    return gen
  }
  const contentType = getDataFieldInfo(dataFields)
  const filteredDataFields = dataFields.filter(
    e => e.contentType == contentType,
  )
  if (filteredDataFields.length === 0) {
    return gen
  }
  let body: any = undefined
  const func = endpoint.isGraphQl ? recurseCreateBodyGraphQl : recurseCreateBody
  for (const dataField of filteredDataFields) {
    const mapTokens = dataField.dataPath?.split(".")
    body = func(body, mapTokens, 0, dataField, ctx.entityMap)
  }

  if (endpoint.isGraphQl) {
    return {
      ...gen,
      req: {
        ...gen.req,
        headers: (gen.req.headers || []).concat({
          name: "Content-Type",
          value: "application/json",
        }),
        data: JSON.stringify(
          {
            query: jsonToGraphQLQuery(body, { pretty: true }),
            variables: {},
          },
          undefined,
          4,
        ),
      },
    }
  } else {
    if (contentType.includes("form")) {
      return {
        ...gen,
        req: {
          ...gen.req,
          headers: (gen.req.headers || []).concat({
            name: "Content-Type",
            value: contentType,
          }),
          form: Object.entries(body).map(([key, val]) => ({
            name: key,
            value: val as string,
          })),
        },
      }
    } else if (
      contentType.includes("json") ||
      contentType == "*/*" ||
      typeof body == "object"
    ) {
      return {
        ...gen,
        req: {
          ...gen.req,
          headers: (gen.req.headers || []).concat({
            name: "Content-Type",
            value: "application/json",
          }),
          data: JSON.stringify(body, null, 4),
        },
      }
    } else if (typeof body == "string") {
      return {
        ...gen,
        req: {
          ...gen.req,
          headers: (gen.req.headers || []).concat({
            name: "Content-Type",
            value: contentType,
          }),
          data: body,
        },
      }
    }
  }
  return gen
}

const addQueryParamsToRequest = (
  gen: GeneratedTestRequest,
  ctx: GenTestContext,
): GeneratedTestRequest => {
  const endpoint = ctx.endpoint
  const isGraphQlGet = endpoint.isGraphQl && endpoint.method === RestMethod.GET
  const dataFields = endpoint.dataFields.filter(e =>
    isGraphQlGet
      ? e.dataSection === DataSection.REQUEST_QUERY ||
        e.dataSection === DataSection.RESPONSE_BODY
      : e.dataSection === DataSection.REQUEST_QUERY,
  )
  if (dataFields.length == 0) {
    return gen
  }
  const pre = ctx.prefix
  let queryParams: KeyValType[] = []
  let env: KeyValType[] = []
  let body: any = undefined

  if (isGraphQlGet) {
    for (const queryField of dataFields) {
      const mapTokens = queryField.dataPath.split(".")
      body = recurseCreateBodyGraphQl(
        body,
        mapTokens,
        0,
        queryField,
        ctx.entityMap,
      )
    }
    queryParams.push({
      name: "query",
      value: jsonToGraphQLQuery(body, { pretty: true }),
    })
  } else {
    for (const queryField of dataFields) {
      if (queryField.entity && ctx.entityMap[queryField.entity]) {
        queryParams.push({
          name: queryField.dataPath,
          value: ctx.entityMap[queryField.entity],
        })
      } else {
        const name = queryField.dataPath
        env.push({
          name: `${pre}${name}`,
          value: `<<${pre}${name}>>`,
        })
        queryParams.push({
          name: queryField.dataPath,
          value: `{{${pre}${name}}}`,
        })
      }
    }
  }
  return {
    ...gen,
    env: gen.env.concat(env),
    req: {
      ...gen.req,
      query: (gen.req.query || []).concat(queryParams),
    },
  }
}

export const makeSampleRequestNoAuthInner = (
  ctx: GenTestContext,
): GeneratedTestRequest => {
  let env: KeyValType[] = []
  ctx.prefix = ctx.prefix ? ctx.prefix + "_" : ""

  let replacedPath = ctx.endpoint.path
  for (const paramField of ctx.endpoint.dataFields.filter(
    e => e.dataSection == DataSection.REQUEST_PATH,
  )) {
    if (paramField.entity && ctx.entityMap[paramField.entity]) {
      replacedPath = replacedPath.replace(
        `{${paramField.dataPath}}`,
        `${ctx.entityMap[paramField.entity]}`,
      )
    } else {
      env.push({
        name: `${ctx.prefix}${paramField.dataPath}`,
        value: `<<${ctx.prefix}${paramField.dataPath}>>`,
      })
      replacedPath = replacedPath.replace(
        `{${paramField.dataPath}}`,
        `{{${ctx.prefix}${paramField.dataPath}}}`,
      )
    }
  }

  env.push({
    name: "BASE_URL",
    value: `{{default BASE_URL "https://${ctx.endpoint.host}"}}`,
  })
  let gen: GeneratedTestRequest = {
    req: {
      method: ctx.endpoint.method,
      url: `{{BASE_URL}}${replacedPath}`,
    },
    env,
  }

  gen = addQueryParamsToRequest(gen, ctx)
  gen = addBodyToRequest(gen, ctx)
  return gen
}

export const makeSampleRequestNoAuth = (
  endpoint: GenTestEndpoint,
  config: TemplateConfig,
  name?: string,
): GeneratedTestRequest => {
  const entityMap = getEntityMap(endpoint, config)
  const ctx = {
    endpoint,
    prefix: name,
    entityMap,
  }
  return makeSampleRequestNoAuthInner(ctx)
}

export const makeSampleRequest = (
  endpoint: GenTestEndpoint,
  config: TemplateConfig,
  name?: string,
): GeneratedTestRequest => {
  const ctx: GenTestContext = {
    endpoint,
    prefix: name,
    entityMap: {},
  }
  let gen = makeSampleRequestNoAuth(endpoint, config, name)
  gen = addAuthToRequest(gen, ctx)
  return gen
}
