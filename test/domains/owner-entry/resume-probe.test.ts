import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OWNER_RESUME_PROBE_SCHEMA_VERSION,
  resolveOwnerEntryResumeProbe,
} from '../../../domains/owner-entry/resume-probe.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { loopSelectionFile, selectLoopChange } from '../../../domains/owner-loop/loop-selection.js';
import { advanceLoopChange } from '../../../domains/owner-loop/loop-transitions.js';
import {
  createLoopPortableChange,
  loopLocalExecutionFile,
} from '../../../domains/owner-loop/loop-portable-runtime.js';
import { loopVerificationFixtureReport } from '../../helpers/loop-verification.js';

const VALID_BRIEF = `# Outcome
Ship cache controls.
# Scope
Cache expiration behavior.
# Non-goals
No storage migration.
# Acceptance examples
- Cache entries expire predictably.
# Constraints and invariants
Preserve existing APIs.
# Decisions
Use Loop state.
# Open questions
None.
# Verification expectations
Run focused cache tests.
`;

const PIPELINE_BUILD_STATE = [
  'workflow: full',
  'phase: build',
  'archived: false',
  'build_pause: null',
  'isolation: branch',
  'build_mode: executing-plans',
  'tdd_mode: direct',
  'review_mode: standard',
  'verify_mode: light',
  'verified_at: null',
  'verify_result: pending',
  'auto_transition: true',
  'design_doc: null',
  'plan: null',
  '',
].join('\n');

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function createLoop(projectRoot: string, name: string, artifactRoot = '.'): Promise<void> {
  const paths = await loopProjectPaths(projectRoot, artifactRoot);
  const state = await createLoopChange({ paths, name, language: 'en' });
  await fs.writeFile(path.join(loopChangeDir(paths, name), state.brief), VALID_BRIEF, 'utf8');
}

async function createPipeline(projectRoot: string, name: string): Promise<void> {
  const changeDir = path.join(projectRoot, 'openspec', 'changes', name);
  await writeFile(path.join(changeDir, '.owner.yaml'), PIPELINE_BUILD_STATE);
  await writeFile(path.join(changeDir, 'proposal.md'), `# ${name}\n`);
  await writeFile(path.join(changeDir, 'design.md'), `# ${name} design\n`);
  await writeFile(path.join(changeDir, 'tasks.md'), '- [ ] finish\n');
}

async function writePipelineProjectConfig(projectRoot: string): Promise<void> {
  await writeFile(
    path.join(projectRoot, '.owner', 'config.yaml'),
    [
      'schema: owner.project.v1',
      'default_workflow: pipeline',
      'workflows: [pipeline]',
      'pipeline:',
      '  artifact_layout: legacy',
      '  language: zh-CN',
      '',
    ].join('\n'),
  );
}

function input(utterance: string, nonTrivialWork = true) {
  return {
    schema_version: OWNER_RESUME_PROBE_SCHEMA_VERSION,
    utterance,
    locale: 'zh-CN',
    agent_context: {
      non_trivial_work: nonTrivialWork,
      already_in_owner_flow: false,
    },
  } as const;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        result[`${relative}/`] = 'directory';
        await visit(absolute);
      } else {
        result[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  await visit(root);
  return result;
}

describe('Owner entry resume probe v2', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-entry-resume-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('routes a configured Loop project only through the permanent Loop entry', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'cache-controls');
    await createPipeline(projectRoot, 'cache-controls');

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 cache-controls')),
    ).resolves.toMatchObject({
      schema_version: 'owner.resume_probe.v2',
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource: 'project-config',
      action: 'auto_resume',
      changeName: 'cache-controls',
      phase: 'shape',
      nextCommand: '/owner-loop',
    });
  });

  it('auto-resumes a portable v4 change without a local execution overlay', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    await createLoopPortableChange({ paths, name: 'portable-resume', language: 'en' });
    await selectLoopChange(paths, 'portable-resume');
    await fs.rm(loopLocalExecutionFile(paths, 'portable-resume'), { force: true });

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 portable-resume')),
    ).resolves.toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      action: 'auto_resume',
      changeName: 'portable-resume',
      phase: 'shape',
      reasonCode: 'loop-change-named',
    });
  });

  it('routes configured Pipeline through its permanent entry and rejects missing config', async () => {
    await writeProjectConfig(projectRoot, {
      ...defaultProjectConfig('.'),
      default_workflow: 'pipeline',
    });
    await createPipeline(projectRoot, 'pipeline-change');
    await createLoop(projectRoot, 'loop-ignored');

    const configured = await resolveOwnerEntryResumeProbe(
      projectRoot,
      input('继续 pipeline-change'),
    );
    expect(configured).toMatchObject({
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      entrySource: 'project-config',
      action: 'auto_resume',
      changeName: 'pipeline-change',
      nextCommand: '/owner-pipeline',
    });

    await fs.rm(path.join(projectRoot, '.owner', 'config.yaml'));
    const missingConfig = await resolveOwnerEntryResumeProbe(
      projectRoot,
      input('继续 pipeline-change'),
    );
    expect(missingConfig).toMatchObject({
      workflow: null,
      skill: null,
      entrySource: null,
      action: 'ask_user',
      reasonCode: 'project-config-invalid',
      nextCommand: null,
    });
  });

  it.each(['loop', 'pipeline'] as const)(
    'stops before inspecting %s workflow state when Ambient Resume is disabled',
    async (workflow) => {
      const config = {
        ...defaultProjectConfig('.'),
        default_workflow: workflow,
        ambient_resume: false,
      };
      await writeProjectConfig(projectRoot, config);
      await createLoop(projectRoot, 'loop-disabled');
      await createPipeline(projectRoot, 'pipeline-disabled');

      await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject(
        {
          workflow: null,
          skill: null,
          action: 'out_of_scope',
          reasonCode: 'ambient-resume-disabled',
          nextCommand: null,
        },
      );
    },
  );

  it('preserves the Pipeline dirty-worktree confirmation rule behind the v2 facade', async () => {
    await writePipelineProjectConfig(projectRoot);
    await createPipeline(projectRoot, 'pipeline-dirty');
    const initialized = spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 pipeline-dirty')),
    ).resolves.toMatchObject({
      workflow: 'pipeline',
      entrySource: 'project-config',
      action: 'ask_user',
      reasonCode: 'pipeline-ask-user',
      changeName: 'pipeline-dirty',
      nextCommand: null,
    });
  });

  it('fails closed with structured Pipeline output when legacy change state is malformed', async () => {
    await writePipelineProjectConfig(projectRoot);
    await writeFile(
      path.join(projectRoot, 'openspec', 'changes', 'broken-pipeline', '.owner.yaml'),
      'workflow: [broken\n',
    );

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 broken-pipeline')),
    ).resolves.toMatchObject({
      schema_version: 'owner.resume_probe.v2',
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      entrySource: 'project-config',
      action: 'ask_user',
      confidence: 'low',
      reasonCode: 'pipeline-state-invalid',
      changeName: null,
      phase: null,
      nextCommand: null,
      reason: expect.stringMatching(/invalid|parse|yaml/iu),
    });
  });

  it('fails closed with a structured result when project config is malformed', async () => {
    await createPipeline(projectRoot, 'must-not-fallback');
    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await writeFile(path.join(projectRoot, '.owner', 'config.yaml'), 'schema: [broken\n');

    await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject({
      schema_version: 'owner.resume_probe.v2',
      workflow: null,
      skill: null,
      entrySource: null,
      action: 'ask_user',
      confidence: 'low',
      reasonCode: 'project-config-invalid',
      changeName: null,
      nextCommand: null,
    });
  });

  it('returns none when the configured Loop workflow has no active changes', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));

    await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      action: 'none',
      reasonCode: 'no-active-loop-changes',
      changeName: null,
      nextCommand: null,
    });
  });

  it('returns none when a stale Loop selection has no active replacement', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    await writeFile(
      loopSelectionFile(paths),
      JSON.stringify({
        schema: 'owner.selection.v2',
        workflow: 'loop',
        change: 'missing-change',
        branch: null,
      }),
    );

    await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      action: 'none',
      reasonCode: 'no-active-loop-changes',
      changeName: null,
      nextCommand: null,
    });
  });

  it('uses Loop selection for multiple changes without guessing from content', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'cache-controls');
    await createLoop(projectRoot, 'login-flow');
    const paths = await loopProjectPaths(projectRoot, '.');

    const ambiguous = await resolveOwnerEntryResumeProbe(projectRoot, input('继续'));
    expect(ambiguous).toMatchObject({
      action: 'ask_user',
      reasonCode: 'multiple-loop-changes',
      changeName: null,
      nextCommand: null,
    });

    await selectLoopChange(paths, 'login-flow');
    const selected = await resolveOwnerEntryResumeProbe(projectRoot, input('继续'));
    expect(selected).toMatchObject({
      action: 'auto_resume',
      changeName: 'login-flow',
      nextCommand: '/owner-loop',
    });

    const explicitlyNamed = await resolveOwnerEntryResumeProbe(
      projectRoot,
      input('继续 cache-controls'),
    );
    expect(explicitlyNamed).toMatchObject({
      action: 'auto_resume',
      changeName: 'cache-controls',
      nextCommand: '/owner-loop',
    });
  });

  it('does not inspect Runtime artifacts for non-target Loop changes', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'cache-controls');
    await createLoop(projectRoot, 'login-flow');
    const paths = await loopProjectPaths(projectRoot, '.');
    await selectLoopChange(paths, 'login-flow');
    const nonTargetRuntime = path.join(loopChangeDir(paths, 'cache-controls'), 'runtime');
    const openedNonTargetRuntimePaths: string[] = [];
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((...args) => {
      const openedPath = String(args[0]);
      if (
        openedPath === nonTargetRuntime ||
        openedPath.startsWith(`${nonTargetRuntime}${path.sep}`)
      ) {
        openedNonTargetRuntimePaths.push(openedPath);
      }
      return originalOpen(...args);
    });

    try {
      await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject(
        {
          action: 'auto_resume',
          changeName: 'login-flow',
          nextCommand: '/owner-loop',
        },
      );
    } finally {
      openSpy.mockRestore();
    }

    expect(openedNonTargetRuntimePaths).toEqual([]);
  });

  it('falls back from a stale selection only when one active Loop change is unambiguous', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'only-active');
    const paths = await loopProjectPaths(projectRoot, '.');
    await writeFile(
      loopSelectionFile(paths),
      JSON.stringify({
        schema: 'owner.selection.v2',
        workflow: 'loop',
        change: 'missing-change',
        branch: null,
      }),
    );

    const sole = await resolveOwnerEntryResumeProbe(projectRoot, input('继续'));
    expect(sole).toMatchObject({
      action: 'auto_resume',
      changeName: 'only-active',
      nextCommand: '/owner-loop',
    });
    expect(sole.evidence).toContainEqual(
      expect.objectContaining({ source: 'state', quote: expect.stringContaining('ENOENT') }),
    );

    await createLoop(projectRoot, 'second-active');
    await expect(resolveOwnerEntryResumeProbe(projectRoot, input('继续'))).resolves.toMatchObject({
      action: 'ask_user',
      reasonCode: 'multiple-loop-changes',
      changeName: null,
      nextCommand: null,
    });
  });

  it('always resumes every valid Loop phase through the permanent Loop entry', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'phase-routing');
    const paths = await loopProjectPaths(projectRoot, '.');
    const changeDir = loopChangeDir(paths, 'phase-routing');
    const phases = ['shape', 'build', 'verify', 'archive'] as const;

    for (const phase of phases) {
      const probe = await resolveOwnerEntryResumeProbe(projectRoot, input('继续 phase-routing'));
      expect(probe).toMatchObject({
        workflow: 'loop',
        action: 'auto_resume',
        changeName: 'phase-routing',
        phase,
        nextCommand: '/owner-loop',
      });

      if (phase === 'shape') {
        const advanced = await advanceLoopChange({
          paths,
          name: 'phase-routing',
          evidence: { summary: 'Shape is complete.', confirmed: true },
        });
        expect(advanced.findings).toEqual([]);
      } else if (phase === 'build') {
        const advanced = await advanceLoopChange({
          paths,
          name: 'phase-routing',
          evidence: {
            summary: 'No code is required for the phase routing fixture.',
            noCodeReason: 'The fixture verifies workflow routing only.',
          },
        });
        expect(advanced.findings).toEqual([]);
      } else if (phase === 'verify') {
        await fs.writeFile(
          path.join(changeDir, 'verification.md'),
          await loopVerificationFixtureReport({ paths, name: 'phase-routing' }),
          'utf8',
        );
        const advanced = await advanceLoopChange({
          paths,
          name: 'phase-routing',
          evidence: {
            summary: 'Verification passed.',
            verificationResult: 'pass',
            verificationReport: 'verification.md',
          },
        });
        expect(advanced.findings).toEqual([]);
      }
    }
  });

  it('does not attach an unrelated request to the only Loop change', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'cache-controls');

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('给 README 添加安装截图')),
    ).resolves.toMatchObject({
      workflow: 'loop',
      action: 'out_of_scope',
      reasonCode: 'request-unrelated',
      changeName: 'cache-controls',
      nextCommand: null,
    });
  });

  it('does not return a resume command for a corrupt Loop target', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    const broken = path.join(paths.changesDir, 'broken-change');
    await writeFile(path.join(broken, 'owner-state.yaml'), 'schema: [broken\n');

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 broken-change')),
    ).resolves.toMatchObject({
      workflow: 'loop',
      action: 'ask_user',
      reasonCode: 'loop-change-invalid',
      changeName: 'broken-change',
      phase: 'invalid',
      nextCommand: null,
    });

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('给 README 添加安装截图')),
    ).resolves.toMatchObject({
      action: 'out_of_scope',
      reasonCode: 'request-unrelated',
      nextCommand: null,
    });
  });

  it('does not auto-resume a Loop change whose artifacts fail validation', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'invalid-brief');
    const paths = await loopProjectPaths(projectRoot, '.');
    await fs.writeFile(
      path.join(loopChangeDir(paths, 'invalid-brief'), 'brief.md'),
      '# Scope\nOnly a scope remains.\n',
      'utf8',
    );

    const probe = await resolveOwnerEntryResumeProbe(projectRoot, input('继续 invalid-brief'));

    expect(probe).toMatchObject({
      workflow: 'loop',
      action: 'ask_user',
      reasonCode: 'loop-change-invalid',
      changeName: 'invalid-brief',
      phase: 'shape',
      nextCommand: null,
    });
    expect(probe.evidence).toContainEqual({
      source: 'state',
      quote: 'finding: brief-section-missing',
    });
  });

  it('does not resume while a Loop artifact-root move is incomplete', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'moving-change');
    const config = defaultProjectConfig('.');
    config.loop.pending_root_move = {
      id: 'deadbeef-0001',
      fromArtifactRoot: '.',
      toArtifactRoot: 'docs',
      stage: 'copying',
    };
    await writeProjectConfig(projectRoot, config);

    await expect(
      resolveOwnerEntryResumeProbe(projectRoot, input('继续 moving-change')),
    ).resolves.toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      action: 'ask_user',
      reasonCode: 'loop-state-invalid',
      changeName: null,
      nextCommand: null,
      reason: expect.stringContaining('owner loop doctor --repair'),
    });
  });

  it('does not make a dirty worktree a Loop resume blocker', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoop(projectRoot, 'cache-controls');
    const initialized = spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'uncommitted user work\n');

    const result = await resolveOwnerEntryResumeProbe(projectRoot, input('继续 cache-controls'));

    expect(result).toMatchObject({
      action: 'auto_resume',
      changeName: 'cache-controls',
      nextCommand: '/owner-loop',
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ source: 'repo', quote: expect.stringContaining('dirty file') }),
    );
  });

  it('discovers a custom Loop root from a nested path and remains read-only', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    await createLoop(projectRoot, 'cache-controls', 'docs');
    const nested = path.join(projectRoot, 'src', 'nested');
    await fs.mkdir(nested, { recursive: true });
    const before = await snapshot(projectRoot);

    const result = await resolveOwnerEntryResumeProbe(nested, input('继续 cache-controls'));

    expect(result).toMatchObject({
      workflow: 'loop',
      action: 'auto_resume',
      changeName: 'cache-controls',
    });
    expect(await snapshot(projectRoot)).toEqual(before);
  });
});
