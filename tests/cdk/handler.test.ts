import { expect, test } from "vitest";
import { lambdaHandler } from "../../infrastructure/cdk/src/handler.js";
import { functionUrlHandler as mockAlphaHandler } from "../../apps/mock-partner-alpha/src/lambda.js";
import { functionUrlHandler as mockBetaHandler } from "../../apps/mock-partner-beta/src/lambda.js";

test("CDK maps each Lambda entry point to its exported handler", () => {
  expect(lambdaHandler("Api")).toBe("httpApiHandler");
  expect(lambdaHandler("Outbox")).toBe("streamHandler");
  expect(lambdaHandler("Reconciler")).toBe("scheduledHandler");
  expect(lambdaHandler("Router")).toBe("sqsHandler");
  expect(lambdaHandler("Delivery")).toBe("sqsHandler");
  expect(lambdaHandler("MockAlpha")).toBe("functionUrlHandler");
  expect(lambdaHandler("MockBeta")).toBe("functionUrlHandler");
});

test("mock Lambda entry points export the function URL handler", () => {
  expect(mockAlphaHandler).toBeTypeOf("function");
  expect(mockBetaHandler).toBeTypeOf("function");
});
