import { memoizedHookRead } from '../../platform/process/hook-read-cache.js';
import { discoverLoopProject } from '../owner-loop/loop-paths.js';
import { readWorkflowProjectConfig } from '../workflow-contract/project-config-reader.js';

/**
 * Shared memoized project-rooted reads for the entry layer.
 *
 * Both the Hook path (`runWithHookReadCache` activated by the hook-router
 * entry) and the resume-probe path (`runWithHookReadCache` activated by the
 * resume-probe entry) consult these wrappers. When no cache scope is active
 * (CLI commands that bypass the entry point), they degrade to the raw reads.
 *
 * `discoverLoopProject` walks the directory tree upward with an lstat per
 * level; `readWorkflowProjectConfig` opens, parses, and hashes
 * `.owner/config.yaml`. Within a single decision both are immutable, so
 * memoizing them removes the 2-3x repeat reads the entry resolution used to
 * perform.
 */
export const readCachedProjectConfig = memoizedHookRead(
  'readWorkflowProjectConfig',
  (projectRoot: string) => readWorkflowProjectConfig(projectRoot),
);

export const discoverCachedLoopProject = memoizedHookRead(
  'discoverLoopProject',
  (startPath: string) => discoverLoopProject(startPath),
);
