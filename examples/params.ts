import type { EventContext } from "@yieldstar/core";
import { workflow } from "yieldstar";
import { createTestSdkFactory } from "@yieldstar/test-utils";
import pino from "pino";

const logger = pino({ level: "info" });

type Params = {
  userId?: string;
  name?: string;
  role?: string;
  action?: string;
};

type Result = {
  success: boolean;
  message: string;
};

const userWorkflow = workflow<Params, Result, EventContext>(async function* (
  step,
  event,
  logger
) {
  const { params } = event;

  logger.info(`Starting workflow for user ${params?.userId || "unknown"}`);

  // Step 1: Fetch user data
  const userData = yield* step.run("fetchUserData", async () => {
    logger.info(`Fetching data for user ${params?.userId}`);

    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      id: params?.userId,
      name: params?.name || "Anonymous",
      role: params?.role || "user",
    };
  });

  // Step 2: Process user data based on action
  const result = yield* step.run("processUserData", async () => {
    const action = params?.action || "view";
    logger.info(`Processing action "${action}" for user ${userData.id}`);

    // Simulate processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    switch (action) {
      case "create":
        return {
          success: true,
          message: `User ${userData.name} created successfully`,
        };
      case "update":
        return {
          success: true,
          message: `User ${userData.name} updated successfully`,
        };
      case "delete":
        return {
          success: true,
          message: `User ${userData.name} deleted successfully`,
        };
      default:
        return {
          success: true,
          message: `User ${userData.name} viewed successfully`,
        };
    }
  });

  logger.info(`Workflow completed with result: ${JSON.stringify(result)}`);

  return result;
});

// Create a test runner
const createSdk = createTestSdkFactory({ logger });

// Run the workflow with different parameters
async function runExample() {
  // Example 1: Create a new user
  const sdk = createSdk({ userWorkflow });
  const result1 = await sdk.triggerAndWait({
    workflowId: "userWorkflow",
    params: {
      userId: "123",
      name: "John Doe",
      role: "admin",
      action: "create",
    },
  });
  console.log("Example 1 Result:", result1);

  // Example 2: Update an existing user
  const result2 = await sdk.triggerAndWait({
    workflowId: "userWorkflow",
    params: {
      userId: "456",
      name: "Jane Smith",
      role: "manager",
      action: "update",
    },
  });
  console.log("Example 2 Result:", result2);

  // Example 3: No parameters (defaults will be used)
  const result3 = await sdk.triggerAndWait({
    workflowId: "userWorkflow",
    params: {},
  });
  console.log("Example 3 Result:", result3);
}

// Run the example
runExample().catch(console.error);
