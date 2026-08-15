/**
 * Text persisted into the Loop Run trajectory must remain readable by every
 * recovery and repair projection. Keep writers and readers on this one limit.
 */
export const LOOP_TRAJECTORY_MAX_TEXT_CHARACTERS = 4_096;

export function assertLoopTrajectoryText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > LOOP_TRAJECTORY_MAX_TEXT_CHARACTERS
  ) {
    throw new Error(
      `${label} must be between 1 and ${LOOP_TRAJECTORY_MAX_TEXT_CHARACTERS} characters`,
    );
  }
}
