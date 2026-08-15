import path from 'path';

import { loopChangeDir } from './loop-change.js';
import { isInsidePath } from './loop-paths.js';
import type {
  LoopChangeState,
  LoopFinding,
  LoopFindingSeverity,
  LoopFindingSummary,
  LoopProjectPaths,
  LoopStructuredFinding,
} from './loop-types.js';
import { isLoopWorkspaceAdvisoryCode } from './loop-workspace.js';

const FINDING_SUMMARY_CODE_BUDGET = 8;

interface FindingMetadata {
  severity: LoopFindingSeverity;
  requiredAction: string;
  retry: 'next' | 'status' | 'none';
  repair: 'doctor' | 'none';
}

const EXACT_METADATA: Record<string, FindingMetadata> = {
  'runtime-missing': {
    severity: 'warning',
    requiredAction: 'rebuild-loop-runtime',
    retry: 'next',
    repair: 'none',
  },
  'runtime-layout-legacy': {
    severity: 'warning',
    requiredAction: 'migrate-loop-runtime-layout',
    retry: 'status',
    repair: 'doctor',
  },
  'runtime-storage-invalid': {
    severity: 'error',
    requiredAction: 'repair-loop-runtime-storage',
    retry: 'status',
    repair: 'doctor',
  },
  'brief-blocking-question': {
    severity: 'error',
    requiredAction: 'answer-blocking-question',
    retry: 'next',
    repair: 'none',
  },
  'shape-confirmation-required': {
    severity: 'error',
    requiredAction: 'confirm-shared-understanding',
    retry: 'next',
    repair: 'none',
  },
  'approval-confirmation-required': {
    severity: 'error',
    requiredAction: 'confirm-shared-understanding',
    retry: 'next',
    repair: 'none',
  },
  'transition-incomplete': {
    severity: 'error',
    requiredAction: 'recover-transition',
    retry: 'status',
    repair: 'doctor',
  },
  'trajectory-tail-incomplete': {
    severity: 'error',
    requiredAction: 'repair-trajectory-tail',
    retry: 'status',
    repair: 'doctor',
  },
  'checkpoint-progress-invalid': {
    severity: 'error',
    requiredAction: 'manually-isolate-invalid-checkpoint',
    retry: 'none',
    repair: 'none',
  },
  'checkpoint-progress-incomplete': {
    severity: 'error',
    requiredAction: 'recover-progress-checkpoint',
    retry: 'status',
    repair: 'doctor',
  },
  'checkpoint-manifest-invalid': {
    severity: 'error',
    requiredAction: 'record-checkpoint-again',
    retry: 'status',
    repair: 'none',
  },
  'verification-scope-partial': {
    severity: 'error',
    requiredAction: 'confirm-partial-verification-scope',
    retry: 'next',
    repair: 'none',
  },
  'verification-implementation-stale': {
    severity: 'error',
    requiredAction: 'return-to-build-and-refresh-implementation-scope',
    retry: 'next',
    repair: 'none',
  },
  'verification-receipt-binding-mismatch': {
    severity: 'error',
    requiredAction: 'refresh-verification-receipts',
    retry: 'next',
    repair: 'none',
  },
  'verification-receipt-stale': {
    severity: 'error',
    requiredAction: 'refresh-verification-receipts',
    retry: 'next',
    repair: 'none',
  },
  'verification-receipt-invalid': {
    severity: 'error',
    requiredAction: 'refresh-verification-receipts',
    retry: 'next',
    repair: 'none',
  },
  'loop-change-conflict': {
    severity: 'error',
    requiredAction: 'resolve-loop-change-conflict',
    retry: 'status',
    repair: 'none',
  },
  'loop-change-overlap': {
    severity: 'error',
    requiredAction: 'inspect-loop-change-overlap',
    retry: 'status',
    repair: 'none',
  },
  'contract-changed-after-approval': {
    severity: 'error',
    requiredAction: 're-confirm-contract',
    retry: 'next',
    repair: 'none',
  },
  'baseline-snapshot-incomplete': {
    severity: 'error',
    requiredAction: 'resolve-loop-baseline',
    retry: 'none',
    repair: 'none',
  },
  'baseline-snapshot-missing': {
    severity: 'error',
    requiredAction: 'resolve-loop-baseline',
    retry: 'none',
    repair: 'none',
  },
  'workspace-inspection-unavailable': {
    severity: 'info',
    requiredAction: 'migrate-workspace-identity',
    retry: 'status',
    repair: 'doctor',
  },
  'workspace-binding-root-changed': {
    severity: 'error',
    requiredAction: 'return-to-bound-working-directory',
    retry: 'status',
    repair: 'none',
  },
  'workspace-binding-invalid': {
    severity: 'error',
    requiredAction: 'repair-workspace-binding',
    retry: 'status',
    repair: 'none',
  },
  'workspace-branch-changed': {
    severity: 'error',
    requiredAction: 'return-to-bound-working-directory',
    retry: 'status',
    repair: 'none',
  },
  'workspace-kind-changed': {
    severity: 'error',
    requiredAction: 'return-to-bound-working-directory',
    retry: 'status',
    repair: 'none',
  },
  'workspace-vcs-unavailable': {
    severity: 'error',
    requiredAction: 'return-to-bound-working-directory',
    retry: 'status',
    repair: 'none',
  },
  'repair-stagnation-warning': {
    severity: 'warning',
    requiredAction: 'change-repair-approach',
    retry: 'next',
    repair: 'none',
  },
  'repair-stagnation-stop': {
    severity: 'error',
    requiredAction: 'try-new-repair-hypothesis-with-status-override',
    retry: 'none',
    repair: 'none',
  },
  'repair-iteration-limit': {
    severity: 'error',
    requiredAction: 'choose-repair-continuation',
    retry: 'none',
    repair: 'none',
  },
  'repair-override-exhausted': {
    severity: 'error',
    requiredAction: 'choose-repair-continuation',
    retry: 'none',
    repair: 'none',
  },
};

function inferredMetadata(code: string): FindingMetadata {
  const exact = EXACT_METADATA[code];
  if (exact) return exact;
  if (
    /^(?:run-|trajectory-|checkpoint-(?:missing|mismatch|invalid)|transition-invalid)/u.test(code)
  ) {
    return {
      severity: 'error',
      requiredAction: 'isolate-or-restore-loop-runtime-from-a-trusted-copy',
      retry: 'none',
      repair: 'none',
    };
  }
  if (code.startsWith('brief-')) {
    return {
      severity: 'error',
      requiredAction: 'complete-brief',
      retry: 'next',
      repair: 'none',
    };
  }
  if (code.startsWith('spec-')) {
    return {
      severity: 'error',
      requiredAction: 'resolve-spec-state',
      retry: 'next',
      repair: 'none',
    };
  }
  if (code.startsWith('verification-')) {
    return {
      severity: 'error',
      requiredAction: 'complete-verification-evidence',
      retry: 'next',
      repair: 'none',
    };
  }
  if (code.startsWith('build-')) {
    return {
      severity: 'error',
      requiredAction: 'record-build-evidence',
      retry: 'next',
      repair: 'none',
    };
  }
  if (isLoopWorkspaceAdvisoryCode(code)) {
    return {
      severity: code === 'workspace-inspection-unavailable' ? 'info' : 'warning',
      requiredAction: 'inspect-workspace-advisory',
      retry: 'status',
      repair: 'none',
    };
  }
  return {
    severity: 'error',
    requiredAction: 'resolve-finding',
    retry: 'status',
    repair: 'none',
  };
}

function projectRelativePath(
  paths: LoopProjectPaths,
  state: LoopChangeState,
  finding: LoopFinding,
): string | null {
  if (!finding.path) return null;
  let target: string;
  if (path.isAbsolute(finding.path)) {
    target = path.resolve(finding.path);
  } else if (/^(?:brief-|verification-|spec-source)/u.test(finding.code)) {
    target = path.resolve(loopChangeDir(paths, state.name), ...finding.path.split(/[\\/]/u));
  } else {
    target = path.resolve(paths.projectRoot, ...finding.path.split(/[\\/]/u));
  }
  if (!isInsidePath(paths.projectRoot, target)) return null;
  const relative = path.relative(paths.projectRoot, target).replaceAll('\\', '/');
  return relative === '' ? '.' : relative;
}

function retryCommand(
  retry: FindingMetadata['retry'],
  state: LoopChangeState,
  code: string,
): string | null {
  if (retry === 'next') {
    return `owner loop next ${state.name} --summary "<summary>"${
      code === 'contract-changed-after-approval' ||
      code === 'shape-confirmation-required' ||
      code === 'approval-confirmation-required'
        ? ' --confirmed'
        : ''
    }`;
  }
  if (retry === 'status') return `owner loop status ${state.name} --details`;
  return null;
}

export function structureLoopFindings(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  findings: readonly LoopFinding[];
}): LoopStructuredFinding[] {
  return options.findings
    .map((finding): LoopStructuredFinding => {
      const metadata = inferredMetadata(finding.code);
      return {
        code: finding.code,
        message: finding.message,
        severity: metadata.severity,
        path: projectRelativePath(options.paths, options.state, finding),
        requiredAction: metadata.requiredAction,
        retryCommand: retryCommand(metadata.retry, options.state, finding.code),
        repairCommand:
          metadata.repair === 'doctor'
            ? `owner loop doctor ${options.state.name} --repair${
                finding.code.startsWith('transition-') ? ' --strategy continue' : ''
              }`
            : null,
        // This is intentionally code-based, not severity-based. Model-actionable
        // missing data must never be presented as a user decision.
        requiresUserDecision:
          finding.code === 'brief-blocking-question' ||
          finding.code === 'shape-confirmation-required' ||
          finding.code === 'approval-confirmation-required' ||
          finding.code === 'contract-changed-after-approval' ||
          finding.code === 'verification-scope-partial' ||
          finding.code === 'repair-iteration-limit' ||
          finding.code === 'repair-override-exhausted',
      };
    })
    .sort((left, right) => {
      const severityRank = { error: 0, warning: 1, info: 2 } as const;
      return (
        severityRank[left.severity] - severityRank[right.severity] ||
        left.code.localeCompare(right.code) ||
        (left.path ?? '').localeCompare(right.path ?? '') ||
        left.message.localeCompare(right.message)
      );
    });
}

export function summarizeLoopFindings(
  findings: readonly LoopStructuredFinding[],
): LoopFindingSummary {
  const codes = [...new Set(findings.map((finding) => finding.code))];
  return {
    total: findings.length,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    requiresUserDecision: findings.some((finding) => finding.requiresUserDecision),
    codes: codes.slice(0, FINDING_SUMMARY_CODE_BUDGET),
    truncated: codes.length > FINDING_SUMMARY_CODE_BUDGET,
  };
}
