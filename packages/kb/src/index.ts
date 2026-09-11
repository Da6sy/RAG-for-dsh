/**
 * `@clue-harness/kb` — the knowledge base engine (M2 skeleton).
 *
 * Business-package discipline (design §2.1): this package imports NO dsh
 * package — its only dsh-facing vocabulary (Branded, SessionId types) comes
 * through `@clue-harness/compat`, and path/IO helpers through
 * `@clue-harness/util`. The Cordis service face (ctx.kb) arrives in M3 when
 * the loop becomes its consumer — engines first, faces on demand.
 *
 * @module @clue-harness/kb
 */
export {
  DEFAULT_KB_CONFIG,
  KB_FORMAT_VERSION,
  // KbEntryId exports BOTH meanings: the brand type and its constructor.
  KbEntryId,
  type ApprovalAction,
  type ApprovalRequest,
  type KbConfig,
  type KbEntry,
  type KbHistoryEvent,
  type KbKind,
  type KbMeta,
  type KbProvenance,
  type KbStatus,
  type KbTier,
  type SignalRecord,
  type SourceBinding,
} from './types.ts'
export {
  applyTransition,
  canTransition,
  clearNeedsReview,
  historyEvent,
  raiseNeedsReview,
  transitionTable,
  type TransitionTrigger,
} from './state-machine.ts'
export {
  appendSignal,
  buildSignal,
  discardThreshold,
  readSignals,
  windowScore,
  type SignalInput,
} from './signals.ts'
export {
  KbStore,
  legacyWorkspaceClueDir,
  migrateWorkspaceKbsToCentral,
  openGlobalStore,
  openProjectStore,
  type AddEntryInput,
  type KbStoreOptions,
  type MigrationEntry,
  type MigrateOptions,
} from './store.ts'
export {
    WORKSPACES_REGISTRY_VERSION,
  addWorkspace,
  findWorkspace,
  getRenderSurface,
  listActiveWorkspaces,
  readWorkspaces,
  registerWorkspace,
  removeWorkspace,
  renameWorkspace,
  setRenderSurface,
  workspacesRegistryFile,
  isLiveRow,
  writeWorkspaces,
  type RenderSurfaceSettings,
  type WorkspaceRecord,
  type WorkspaceRegistry,
  type WorkspaceSource,
} from './workspaces.ts'
export {
  annotationsFor,
  DEFAULT_WEIGHTS,
  queryKb,
  tokenize,
  type QueryHit,
  type QueryOptions,
  type RetrievalWeights,
} from './query.ts'
export {
  keepWorkspace,
  listTrash,
  panelWorkspaces,
  purgeAllOrphans,
  purgeWorkspace,
  sideTableFile,
  syncWorkspaces,
  trashDirFor,
  type HostWorkspaceRow,
  type PurgedPiece,
  WorkspaceNotPurgeableError,
  WorkspaceUnknownError,
  type WorkspaceSyncReport,
} from './workspace-sync.ts'
