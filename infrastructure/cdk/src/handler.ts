/** Maps each deployable entry point to the symbol it exports for Lambda. */
export function lambdaHandler(id: string): string {
  if (id === "Api") return "httpApiHandler";
  if (id === "Reconciler") return "scheduledHandler";
  if (id === "Outbox") return "streamHandler";
  if (id === "MockAlpha" || id === "MockBeta") return "functionUrlHandler";
  return "sqsHandler";
}
