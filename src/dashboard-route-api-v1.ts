// The external read API, `/api/v1/` (ADR 0027, docs/api.md): a documented, stable contract for an
// outside consumer, separate from the dashboard's own unversioned `/api/*` routes. Its JSON comes
// only from the explicit mappers below, which copy named fields out of the dashboard model and
// never spread or pass a model object through — so a field added to or renamed in that model
// cannot reach v1 JSON. Within v1, changes are additive only; `src/dashboard-route-api-v1.test.ts`
// pins every shape.
import {
  buildAllStatus,
  campaignState,
  liveWaves,
  parkReasonFromEvent,
  type CampaignState,
  type CampaignStatus,
  type IssueStatus,
  type Membership,
  type ParkReason,
  type WaveStatus,
} from "./dashboard-model.ts";
import { listProjects, type ProjectPointer } from "./registry.ts";
import type { RouteHandler } from "./dashboard-http.ts";

export interface V1Projects {
  projects: V1ProjectSummary[];
}

export interface V1ProjectSummary {
  project: string;
  repo: string | null;
  campaign: {
    name: string | null;
    status: CampaignState;
    issues: Record<IssueStatus, number>;
  };
}

export interface V1Campaign {
  project: string;
  repo: string | null;
  name: string | null;
  status: CampaignState;
  waves: V1Wave[];
  parked: V1Parked[];
}

export interface V1Wave {
  index: number;
  status: WaveStatus;
  reason: ParkReason | null;
  members: V1Member[];
}

export interface V1Member {
  issue: string;
  status: IssueStatus;
  reason: ParkReason | null;
  membership: Membership;
}

export interface V1Parked {
  issue: string;
  reason: ParkReason;
  parkedAt: string;
  question: string;
}

/**
 * A campaign's v1 status: the campaign fold over its live waves, except that a parked record
 * reads `parked` over a `running`/`completed`/`unstarted` fold (a `failed` fold stays `failed`) —
 * `cardState`'s rule without its collapse to `idle`, so a park that outlived its log still reads
 * `parked`. No waves fold to `unstarted`.
 */
export const apiV1CampaignState = (status: Pick<CampaignStatus, "waves" | "parked">): CampaignState => {
  const fold = campaignState(liveWaves(status).map((wave) => wave.status));
  return status.parked.length && fold !== "failed" ? "parked" : fold;
};

/** The v1 detail of one project's campaign — its live waves (a wholly-pruned wave left out) and its parked records. */
export const apiV1Campaign = (status: CampaignStatus, pointer: Pick<ProjectPointer, "repo">): V1Campaign => ({
  project: status.project,
  repo: pointer.repo ?? null,
  name: status.name ?? null,
  status: apiV1CampaignState(status),
  waves: liveWaves(status).map((wave): V1Wave => ({
    index: wave.index,
    status: wave.status,
    reason: wave.reason ?? null,
    members: wave.issues.map((issue): V1Member => ({
      issue: issue.issueNumber,
      status: issue.status,
      reason: issue.reason ?? null,
      membership: issue.membership ?? "member",
    })),
  })),
  parked: status.parked.map((parked): V1Parked => ({
    issue: parked.issueNumber,
    reason: parkReasonFromEvent(parked.reason),
    parkedAt: parked.parkedAt,
    question: parked.description,
  })),
});

/** One project's v1 summary — its campaign's name, status, and every live, unpruned member counted by status. */
export const apiV1ProjectSummary = (status: CampaignStatus, pointer: Pick<ProjectPointer, "repo">): V1ProjectSummary => {
  const issues: Record<IssueStatus, number> = { unstarted: 0, running: 0, parked: 0, completed: 0, failed: 0 };
  for (const wave of liveWaves(status)) for (const issue of wave.issues) if (issue.membership !== "pruned") issues[issue.status]++;
  return {
    project: status.project,
    repo: pointer.repo ?? null,
    campaign: { name: status.name ?? null, status: apiV1CampaignState(status), issues },
  };
};

const sendJson = (res: Parameters<RouteHandler>[1], body: V1Projects | V1Campaign) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** `GET /api/v1/projects` — one summary per registered project whose base location still exists. */
export const handleApiV1Projects: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/v1/projects")) return false;
  const pointers = listProjects(deps.configDir);
  const projects = buildAllStatus(pointers, undefined, deps.configDir).map((status) =>
    apiV1ProjectSummary(status, pointers.find((p) => p.project === status.project) ?? {}),
  );
  sendJson(res, { projects });
  return true;
};

/** `GET /api/v1/campaign?project=<name>` — one project's campaign, found by exact registry name;
 * a missing or unknown name, or a base location that is gone, answers 404. */
export const handleApiV1Campaign: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/v1/campaign")) return false;
  const project = url.searchParams.get("project");
  const pointer = project ? listProjects(deps.configDir).find((p) => p.project === project) : undefined;
  const [status] = pointer ? buildAllStatus([pointer], undefined, deps.configDir) : [];
  if (!pointer || !status) {
    res.writeHead(404).end("not found");
    return true;
  }
  sendJson(res, apiV1Campaign(status, pointer));
  return true;
};
