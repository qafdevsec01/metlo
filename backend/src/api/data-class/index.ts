import { Request, Response } from "express";
import { DataClassService } from "../../services/data-class";
import { IsRiskParams } from "../../types";
import ApiResponseHandler from "../../api-response-handler";
import Error400BadRequest from "../../errors/error-400-bad-request";
import { AppDataSource } from "../../data-source";
import { ApiEndpoint } from "../../../models";
import { getRiskScore } from "../../utils";

export const isRiskHandler = async (req: Request, res: Response) => {
  try {
    const { isRisk }: IsRiskParams = req.body;
    const { dataClassId } = req.params;
    if (isRisk === null || isRisk === undefined) {
      throw new Error400BadRequest("isRisk not provided.");
    }
    const updatedMatchedDataClass = await DataClassService.updateIsRisk(
      isRisk,
      dataClassId
    );
    if (updatedMatchedDataClass) {
      const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint);
      const apiEndpoint = await apiEndpointRepository.findOne({
        where: { uuid: updatedMatchedDataClass.apiEndpointUuid },
        relations: { sensitiveDataClasses: true },
      });
      apiEndpoint.riskScore = getRiskScore(apiEndpoint);
      await apiEndpointRepository.save(apiEndpoint);
    }
    await ApiResponseHandler.success(res, null);
  } catch (err) {
    await ApiResponseHandler.error(res, err);
  }
};