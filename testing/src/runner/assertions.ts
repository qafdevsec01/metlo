import { AxiosResponse } from "axios"
import { executeScript, stringReplacement } from "../utils"
import { Context } from "../types/context"
import { AssertionType } from "../types/enums"
import { Assertion } from "../types/test"
import { getKeyValue } from "./utils"

export const runAssertion = (
  assertion: Assertion,
  response: AxiosResponse,
  ctx: Context,
): boolean => {
  if (typeof assertion == "string") {
    assertion = {
      type: AssertionType.enum.JS,
      value: assertion,
    }
  }

  if (assertion.type == AssertionType.enum.JS) {
    if ((typeof assertion.value).toLowerCase() === "string") {
      const assertionValue = stringReplacement(
        assertion.value as string,
        ctx.envVars,
      )
      return !!executeScript(assertionValue, response, ctx)
    } else {
      throw new Error(
        `Script must be of type string. Received script of type ${typeof assertion.value}`,
      )
    }
  }
  if (!assertion.key) {
    throw new Error("Must specify a key for assertion")
  }
  let assertionKey = undefined
  let assertionValue = undefined
  if ((typeof assertion.key).toLowerCase() == "string") {
    assertionKey = stringReplacement(assertion.key as string, ctx.envVars)
  } else {
    assertionKey = assertion.key
  }
  if ((typeof assertion.value).toLowerCase() == "string") {
    assertionValue = stringReplacement(assertion.value as string, ctx.envVars)
  } else {
    assertionValue = assertion.value
  }
  const currentValue = getKeyValue(assertionKey, response, ctx)
  if (assertion.type == AssertionType.enum.EQ) {
    if (assertionValue instanceof Array) {
      return assertionValue.some(e => e == currentValue)
    } else {
      return assertionValue === currentValue
    }
  } else if (assertion.type == AssertionType.enum.REGEXP) {
    const regex = new RegExp(assertionValue as string)
    return regex.test(currentValue)
  }
  return false
}
