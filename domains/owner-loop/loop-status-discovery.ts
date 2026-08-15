import path from 'node:path';

import { listGitWorktreeRoots } from '../../platform/paths/git-worktree.js';

import { canonicalHash } from './loop-canonical-hash.js';
import { inspectLoopChangeStateDocument } from './loop-change.js';
import { readProjectConfig } from './loop-config.js';
import {
  inspectLoopStatus,
  listLoopChangeNames,
  LOOP_STATUS_PAGE_LIMITS,
} from './loop-diagnostics.js';
import { loopProjectPaths } from './loop-paths.js';
import {
  inspectLoopPortableStatus,
  type LoopPortableStatusProjection,
} from './loop-portable-status.js';
import { isLoopPortableChange } from './loop-portable-runtime.js';
import { projectLoopWorkspace } from './loop-workspace.js';
import type {
  OwnerProjectConfig,
  LoopProjectPaths,
  LoopStatusProjection,
  LoopWorkspaceProjection,
} from './loop-types.js';

const DISCOVERY_CURSOR_PATTERN =
  /^loop-workspaces-v1\.([a-f0-9]{64})\.([0-9a-z]+)\.([a-f0-9]{64})$/u;

interface LoopWorkspaceSource {
  projectRoot: string;
  config: OwnerProjectConfig;
  paths: LoopProjectPaths;
  changes: Array<{ name: string; kind: 'portable' | 'legacy' }>;
}

interface LoopStatusCandidate {
  source: LoopWorkspaceSource;
  name: string;
  kind: 'portable' | 'legacy';
  workspace: LoopWorkspaceProjection | LoopPortableStatusProjection['workspace'];
  portableStatus: LoopPortableStatusProjection | null;
}

export type LoopDiscoveredStatusProjection =
  | LoopStatusProjection
  | LoopPortableStatusProjection
  | LoopLegacyMigrationStatusProjection;

export interface LoopLegacyMigrationStatusProjection {
  schema: 'owner.loop.status.v2';
  name: string;
  phase: string;
  status: 'blocked';
  migrationRequired: true;
  legacySchema: string;
  workspace: LoopWorkspaceProjection;
  continuation: {
    schema: 'owner.loop.continuation.v2';
    skill: 'owner-loop';
    change: string;
    phase: string;
    status: 'blocked';
    disposition: 'blocked';
    action: 'none';
    commandArgs: string[];
    requiredInputs: [];
    runnerAction: {
      kind: 'none';
      candidateId: null;
      iteration: 0;
      attempt: 0;
    };
  };
}

export interface LoopDiscoveredStatusPageProjection {
  schema: 'owner.loop.status-page.v1' | 'owner.loop.status-page.v2';
  total: number;
  offset: number;
  items: LoopDiscoveredStatusProjection[];
  nextCursor: string | null;
  nextPageCommand: string | null;
  nextPageArgs: string[] | null;
  limits: typeof LOOP_STATUS_PAGE_LIMITS;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function displayCommandArgs(args: readonly string[]): string {
  return args
    .map((value) => (/^[A-Za-z0-9_./:=+@-]+$/u.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

async function discoverChanges(paths: LoopProjectPaths): Promise<LoopWorkspaceSource['changes']> {
  const changes: LoopWorkspaceSource['changes'] = [];
  for (const name of await listLoopChangeNames(paths)) {
    changes.push({
      name,
      kind: (await isLoopPortableChange(paths, name)) ? 'portable' : 'legacy',
    });
  }
  return changes;
}

async function discoverSources(projectRoot: string): Promise<LoopWorkspaceSource[]> {
  const roots = listGitWorktreeRoots(projectRoot);
  const candidates = roots.length > 0 ? roots : [path.resolve(projectRoot)];
  if (!candidates.some((candidate) => samePath(candidate, projectRoot))) {
    candidates.push(path.resolve(projectRoot));
  }
  const sources: LoopWorkspaceSource[] = [];
  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))].sort()) {
    const config = await readProjectConfig(candidate);
    if (!config) continue;
    const paths = await loopProjectPaths(candidate, config.loop.artifact_root);
    sources.push({
      projectRoot: candidate,
      config,
      paths,
      changes: await discoverChanges(paths),
    });
  }
  if (sources.length === 0) {
    const config = await readProjectConfig(projectRoot);
    if (!config) throw new Error('.owner/config.yaml was not found in any registered worktree');
    const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
    sources.push({
      projectRoot: path.resolve(projectRoot),
      config,
      paths,
      changes: await discoverChanges(paths),
    });
  }
  return sources;
}

function candidateRank(candidate: LoopStatusCandidate, requestedRoot: string): number {
  if (candidate.workspace.bindingState === 'aligned') return 0;
  if (samePath(candidate.source.projectRoot, requestedRoot)) return 1;
  if (candidate.workspace.bindingState === 'legacy') return 2;
  if (candidate.workspace.bindingState === 'missing') return 3;
  if (candidate.workspace.bindingState === 'drifted') return 4;
  return 5;
}

async function discoverCandidates(
  projectRoot: string,
  sources: readonly LoopWorkspaceSource[],
): Promise<LoopStatusCandidate[]> {
  const grouped = new Map<
    string,
    Array<{ source: LoopWorkspaceSource; kind: 'portable' | 'legacy' }>
  >();
  for (const source of sources) {
    for (const change of source.changes) {
      grouped.set(change.name, [
        ...(grouped.get(change.name) ?? []),
        { source, kind: change.kind },
      ]);
    }
  }
  const selected: LoopStatusCandidate[] = [];
  for (const [name, nameSources] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const candidates = await Promise.all(
      nameSources.map(async ({ source, kind }): Promise<LoopStatusCandidate> => {
        if (kind === 'portable') {
          const portableStatus = await inspectLoopPortableStatus({ paths: source.paths, name });
          return {
            source,
            name,
            kind,
            workspace: portableStatus.workspace,
            portableStatus,
          };
        }
        return {
          source,
          name,
          kind,
          workspace: await projectLoopWorkspace(source.paths, name),
          portableStatus: null,
        };
      }),
    );
    candidates.sort((left, right) => {
      const rank = candidateRank(left, projectRoot) - candidateRank(right, projectRoot);
      return rank || left.source.projectRoot.localeCompare(right.source.projectRoot);
    });
    const aligned = candidates.filter(
      (candidate) => candidate.workspace.bindingState === 'aligned',
    );
    if (aligned.length > 1) {
      selected.push(...aligned);
    } else {
      selected.push(aligned[0] ?? candidates[0]);
    }
  }
  if (selected.length > LOOP_STATUS_PAGE_LIMITS.maxChanges) {
    throw new Error(
      `Loop status discovery exceeds ${LOOP_STATUS_PAGE_LIMITS.maxChanges} visible changes`,
    );
  }
  return selected.sort((left, right) =>
    `${left.name}\0${left.source.projectRoot}`.localeCompare(
      `${right.name}\0${right.source.projectRoot}`,
    ),
  );
}

function discoveryCursor(candidatesHash: string, offset: number): string {
  const encodedOffset = offset.toString(36);
  const integrity = canonicalHash('owner.loop.workspace-status-cursor.v1', {
    candidatesHash,
    offset,
  });
  return `loop-workspaces-v1.${candidatesHash}.${encodedOffset}.${integrity}`;
}

function discoveryOffset(options: {
  candidatesHash: string;
  total: number;
  cursor?: string | null;
}): number {
  if (options.cursor === undefined || options.cursor === null) return 0;
  const match = DISCOVERY_CURSOR_PATTERN.exec(options.cursor);
  if (!match || match[1] !== options.candidatesHash) {
    throw new Error('Loop workspace status cursor is invalid or stale');
  }
  const offset = Number.parseInt(match[2], 36);
  if (
    !Number.isSafeInteger(offset) ||
    offset <= 0 ||
    offset >= options.total ||
    offset.toString(36) !== match[2]
  ) {
    throw new Error('Loop workspace status cursor offset is invalid');
  }
  const integrity = canonicalHash('owner.loop.workspace-status-cursor.v1', {
    candidatesHash: options.candidatesHash,
    offset,
  });
  if (match[3] !== integrity) throw new Error('Loop workspace status cursor integrity failed');
  return offset;
}

function pageAction(
  projectRoot: string,
  cursor: string | null,
): {
  nextPageCommand: string | null;
  nextPageArgs: string[] | null;
} {
  const args = cursor
    ? ['owner', 'loop', 'status', '--cursor', cursor, '--project-root', projectRoot, '--json']
    : null;
  return {
    nextPageCommand: args ? displayCommandArgs(args) : null,
    nextPageArgs: args,
  };
}

async function inspectLegacyCandidate(
  candidate: LoopStatusCandidate,
  details: boolean,
  acceptanceCursor?: string,
): Promise<LoopStatusProjection | LoopLegacyMigrationStatusProjection> {
  let inspection: Awaited<ReturnType<typeof inspectLoopChangeStateDocument>> | null = null;
  try {
    inspection = await inspectLoopChangeStateDocument(candidate.source.paths, candidate.name);
  } catch {
    // The legacy status adapter below owns malformed and missing-state diagnostics.
  }
  if (inspection?.state) {
    return {
      schema: 'owner.loop.status.v2',
      name: candidate.name,
      phase: inspection.state.phase,
      status: 'blocked',
      migrationRequired: true,
      legacySchema: inspection.schema,
      workspace: candidate.workspace as LoopWorkspaceProjection,
      continuation: {
        schema: 'owner.loop.continuation.v2',
        skill: 'owner-loop',
        change: candidate.name,
        phase: inspection.state.phase,
        status: 'blocked',
        disposition: 'blocked',
        action: 'none',
        commandArgs: ['owner', 'loop', 'doctor', candidate.name, '--repair'],
        requiredInputs: [],
        runnerAction: {
          kind: 'none',
          candidateId: null,
          iteration: 0,
          attempt: 0,
        },
      },
    };
  }
  return inspectLoopStatus(candidate.source.paths, candidate.name, {
    details,
    ...(acceptanceCursor ? { acceptanceCursor } : {}),
    clarificationMode: candidate.source.config.loop.clarification_mode,
    maxVerifyFailures: candidate.source.config.loop.max_verify_failures,
  });
}

async function inspectCandidate(
  candidate: LoopStatusCandidate,
  details: boolean,
  acceptanceCursor?: string,
): Promise<LoopDiscoveredStatusProjection> {
  if (candidate.kind === 'portable') {
    if (acceptanceCursor) {
      throw new Error('Portable Loop status includes the complete acceptance list');
    }
    if (!details && candidate.portableStatus) return candidate.portableStatus;
    return inspectLoopPortableStatus({
      paths: candidate.source.paths,
      name: candidate.name,
      details,
    });
  }
  return inspectLegacyCandidate(candidate, details, acceptanceCursor);
}

export async function inspectDiscoveredLoopStatus(options: {
  projectRoot: string;
  name: string;
  details?: boolean;
  acceptanceCursor?: string;
}): Promise<LoopDiscoveredStatusProjection> {
  const sources = await discoverSources(options.projectRoot);
  const candidates = (await discoverCandidates(options.projectRoot, sources)).filter(
    (candidate) => candidate.name === options.name,
  );
  if (candidates.length === 0) {
    const current =
      sources.find((source) => samePath(source.projectRoot, options.projectRoot)) ?? sources[0];
    return inspectLoopStatus(current.paths, options.name, {
      details: options.details,
      ...(options.acceptanceCursor ? { acceptanceCursor: options.acceptanceCursor } : {}),
      clarificationMode: current.config.loop.clarification_mode,
      maxVerifyFailures: current.config.loop.max_verify_failures,
    });
  }
  if (candidates.length > 1) {
    throw new Error(
      `Loop change ${options.name} has multiple aligned workspace bindings: ${candidates
        .map((candidate) => candidate.source.projectRoot)
        .join(', ')}`,
    );
  }
  return inspectCandidate(candidates[0], options.details ?? false, options.acceptanceCursor);
}

export async function listDiscoveredLoopStatusPage(options: {
  projectRoot: string;
  cursor?: string | null;
}): Promise<LoopDiscoveredStatusPageProjection> {
  const sources = await discoverSources(options.projectRoot);
  const candidates = await discoverCandidates(options.projectRoot, sources);
  const candidatesHash = canonicalHash(
    'owner.loop.workspace-status-candidates.v1',
    candidates.map((candidate) => ({
      name: candidate.name,
      projectRoot: candidate.source.projectRoot,
      bindingState: candidate.workspace.bindingState,
      kind: candidate.kind,
    })),
  );
  const offset = discoveryOffset({
    candidatesHash,
    total: candidates.length,
    cursor: options.cursor,
  });
  const projected = await Promise.all(
    candidates
      .slice(offset, offset + LOOP_STATUS_PAGE_LIMITS.maxItems)
      .map((candidate) => inspectCandidate(candidate, false)),
  );
  const items: LoopDiscoveredStatusProjection[] = [];
  const schema = candidates.some(({ kind }) => kind === 'portable')
    ? ('owner.loop.status-page.v2' as const)
    : ('owner.loop.status-page.v1' as const);
  for (const candidate of projected) {
    const trialItems = [...items, candidate];
    const nextOffset = offset + trialItems.length;
    const nextCursor =
      nextOffset < candidates.length ? discoveryCursor(candidatesHash, nextOffset) : null;
    const trial: LoopDiscoveredStatusPageProjection = {
      schema,
      total: candidates.length,
      offset,
      items: trialItems,
      nextCursor,
      ...pageAction(path.resolve(options.projectRoot), nextCursor),
      limits: { ...LOOP_STATUS_PAGE_LIMITS },
    };
    if (
      Buffer.byteLength(JSON.stringify(trial), 'utf8') > LOOP_STATUS_PAGE_LIMITS.maxSerializedBytes
    ) {
      if (items.length === 0) {
        throw new Error('Loop workspace status item exceeds its page serialization budget');
      }
      break;
    }
    items.push(candidate);
  }
  const nextOffset = offset + items.length;
  const nextCursor =
    nextOffset < candidates.length ? discoveryCursor(candidatesHash, nextOffset) : null;
  return {
    schema,
    total: candidates.length,
    offset,
    items,
    nextCursor,
    ...pageAction(path.resolve(options.projectRoot), nextCursor),
    limits: { ...LOOP_STATUS_PAGE_LIMITS },
  };
}
