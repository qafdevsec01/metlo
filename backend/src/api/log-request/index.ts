import { Request, Response } from "express";
import { LogRequestService } from "../../services/log-request";
import { TraceParams } from "types";

export const logRequestSingleHandler = async (req: Request, res: Response) => {
  const traceParams: TraceParams = req.body;
  await LogRequestService.logRequest(traceParams);
}

export const logRequestBatchHandler = async (req: Request, res: Response) => {
  const traceParamsBatch: TraceParams[] = req.body;
  await LogRequestService.logRequestBatch(traceParamsBatch);
}