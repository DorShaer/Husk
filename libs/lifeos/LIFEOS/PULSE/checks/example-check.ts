/**
 * Example Health Check
 *
 * Health checks run on the interval defined in PULSE.toml.
 * They report status back to the Pulse dashboard.
 *
 * Copy this file and rename it to create your own check.
 */

export interface CheckResult {
  name: string
  status: "pass" | "warn" | "fail"
  message: string
  details?: Record<string, unknown>
}

export async function run(): Promise<CheckResult> {
  try {
    // Implement your health check logic here
    // Examples:
    // - Check if a service is responding
    // - Verify disk space
    // - Check API rate limits
    // - Monitor queue depth

    const healthy = true // Replace with actual check

    return {
      name: "example-check",
      status: healthy ? "pass" : "fail",
      message: healthy ? "All systems nominal" : "Check failed",
      details: {
        checkedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return {
      name: "example-check",
      status: "fail",
      message: `Check error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
