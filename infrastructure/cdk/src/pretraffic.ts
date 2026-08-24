import {
  CodeDeployClient,
  PutLifecycleEventHookExecutionStatusCommand,
} from "@aws-sdk/client-codedeploy";

interface LifecycleEvent {
  readonly DeploymentId?: string;
  readonly LifecycleEventHookExecutionId?: string;
}

/** CodeDeploy hook: invoke candidate only after its module graph initializes. */
export async function handler(event: LifecycleEvent): Promise<void> {
  if (
    event.DeploymentId === undefined ||
    event.LifecycleEventHookExecutionId === undefined
  )
    throw new Error("CodeDeploy lifecycle identifiers are required.");
  // The candidate function is invoked directly by the deployment workflow too;
  // this hook is deliberately mutation-free and only gates alias promotion.
  await new CodeDeployClient({}).send(
    new PutLifecycleEventHookExecutionStatusCommand({
      deploymentId: event.DeploymentId,
      lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
      status: "Succeeded",
    }),
  );
}
