export {
  defineConfig,
  loadConfig,
  resolveDestination,
  questionDestinations,
} from "./config.ts";
export type {
  VetinariConfig,
  ResolvedConfig,
  GateSpec,
  MountSpec,
  Destination,
  NotifyMap,
  MessageCategory,
} from "./config.ts";
export { runLoop, answerPromptFor, DONE, BLOCKED } from "./loop.ts";
export type { Outcome, ResumeEntry } from "./loop.ts";
export { runGates } from "./gate.ts";
export { makeSandbox, agentFor } from "./sandbox.ts";
export { baseline, campaign, queue, tgTest } from "./modes.ts";
export {
  gateway,
  loadGatewayProjects,
  pollTargets,
  pollLoop,
  pendingAnnouncements,
  rebuildIndex,
  newReplyIndex,
  newPendingConfirms,
  recordSend,
  resolveReply,
  routeReply,
  isStatusCommand,
  parseGatewayCommand,
  resolveCarveTarget,
  handleCarveCommand,
  formatCarveAmbiguity,
  formatGatewayStatus,
} from "./gateway.ts";
export type {
  GatewayProject,
  SendRef,
  ReplyIndex,
  Announcement,
  ReplyAction,
  PollDeps,
  GatewayCommand,
  CarveCandidate,
  CarveResolution,
  PendingConfirm,
  PendingConfirms,
  CarveHandlerDeps,
} from "./gateway.ts";
export { computeCarve, restrictBlockers } from "./carve.ts";
export {
  formatContextLine,
  formatStatusLine,
  runStatusLine,
  trimModelName,
} from "./statusline.ts";
export type { CarveResult, BlockedByOf, RestrictedBlockers } from "./carve.ts";
export {
  layerWaves,
  partitionWaves,
  waveArgs,
  describePlan,
  planCampaign,
  underspecifiedPromptFor,
} from "./plan.ts";
export type {
  WavePlan,
  Placement,
  UnreachableTicket,
  CampaignPlan,
  CampaignPlanDeps,
  UnderspecifiedDecision,
  UnderspecifiedPrompt,
} from "./plan.ts";
export {
  githubBlockedBy,
  githubFetchTask,
  githubFindingReporter,
  githubMarkPendingVerify,
} from "./github.ts";
export { defaultFileSet } from "./fileset.ts";
export type { FileSet, FileSetOf } from "./fileset.ts";
export { parseFindings, reportFindings } from "./findings.ts";
export { archiveRun } from "./archive.ts";
export type { ArchiveResult } from "./archive.ts";
export {
  computeLayoutMigration,
  applyLayoutMigration,
  scanLayout,
  describeMigration,
} from "./migrate.ts";
export type {
  LayoutScan,
  LayoutMigrationPlan,
  Move,
  ApplyResult,
} from "./migrate.ts";
export { computeInit, applyInit, scanInit, describeInit } from "./init.ts";
export type {
  InitScan,
  InitPlan,
  FileCreate,
  ApplyInitResult,
} from "./init.ts";
export {
  parseFragment,
  collectFragments,
  scanFragments,
  applyCollect,
  formatMilestoneDate,
  FRAGMENT_DIR,
  SECTION_ORDER,
} from "./changelog.ts";
export type { FragmentSection, Fragment, CollectOptions } from "./changelog.ts";
export {
  buildInstalledCommand,
  composeStatusLine,
  computeInstall,
  computeUninstall,
  DEFAULT_RUN_COMMAND,
  describeInstall,
  describeUninstall,
  parseInstalledCommand,
  readSettings,
  SETTINGS_REL,
  writeSettings,
} from "./statusline-install.ts";
export type { Settings, StatusLineBlock } from "./statusline-install.ts";
export type {
  Finding,
  FindingReporter,
  FindingContext,
  FindingResult,
} from "./findings.ts";
export {
  listParked,
  readParked,
  hasParked,
  clearParked,
  park,
} from "./state.ts";
export type { ParkedRecord, ParkReason } from "./state.ts";
export { tgSend, tgWaitReply, tgConfigured } from "./telegram.ts";
export {
  register,
  listProjects,
  readProject,
  readProjects,
  pointerFor,
  autoRegister,
  gatewayConfigDir,
} from "./registry.ts";
export type { ProjectPointer, ReadProject } from "./registry.ts";
export {
  loggerForRun,
  hostLogger,
  hostLogTarget,
  memoryLogger,
} from "./log.ts";
export type { Logger, MemoryLogger } from "./log.ts";
