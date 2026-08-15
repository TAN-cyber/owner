export interface LoopReceiptFenceChangedPath {
  path: string;
  kind: 'added' | 'modified' | 'removed';
}

export interface LoopReceiptScopeRecovery {
  reason: 'implementation-scope-stale' | 'implementation-changed-during-command';
  commandExecuted: boolean;
  expectedScopeHash: string;
  actualScopeHash: string;
  expectedSnapshotHash: string;
  actualSnapshotHash: string;
  changedPaths: LoopReceiptFenceChangedPath[];
  changedPathCount: number;
  changedPathsTruncated: boolean;
  requiredAction: 'return-to-build-and-refresh-implementation-scope';
  nextCommand: string;
  requiresUserDecision: false;
}

export class LoopReceiptScopeStaleError extends Error {
  readonly recovery: LoopReceiptScopeRecovery;

  constructor(message: string, recovery: LoopReceiptScopeRecovery) {
    super(message);
    this.name = 'LoopReceiptScopeStaleError';
    this.recovery = recovery;
  }
}
