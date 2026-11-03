// Tenancy, roles and entitlement. Default deny: every lookup is scoped to the caller's active memberships.
import { sql } from "./db.ts";
import { forbidden, HttpError, notFound } from "./http.ts";
import type { AuthUser } from "./auth.ts";

export type Role = "owner" | "admin" | "facilitator" | "member";
const RANK: Record<Role, number> = { member: 1, facilitator: 2, admin: 3, owner: 4 };

export const DEFAULT_CONTEXT = {
  objectives: [], domain: [], technology: [], audience: [], terminology: [], constraints: [], success_criteria: [], known_facts: [], unknowns: [], entities: [],
};

/** Ensure app user, personal workspace and default programme exist. Idempotent. */
export async function bootstrapUser(u: AuthUser) {
  const db = sql();
  return await db.begin(async (t) => {
    await t`insert into app.users (id, phone, last_seen_at) values (${u.id}, ${u.phone}, now())
            on conflict (id) do update set last_seen_at = now(), phone = coalesce(excluded.phone, app.users.phone)`;
    const m = await t`select workspace_id from app.memberships where user_id = ${u.id} and status = 'active' limit 1`;
    if (m.length) return;
    const [ws] = await t`insert into app.workspaces (name) values (${"My workspace"}) returning id`;
    await t`insert into app.memberships (workspace_id, user_id, role) values (${ws.id}, ${u.id}, 'owner')`;
    const [p] = await t`insert into app.programmes (workspace_id, title, description, created_by)
                        values (${ws.id}, 'General', 'Default programme', ${u.id}) returning id`;
    await t`insert into app.context_profiles (workspace_id, programme_id, version, content, created_by)
            values (${ws.id}, ${p.id}, 1, ${t.json(DEFAULT_CONTEXT)}, ${u.id})`;
    await t`select app.audit(${ws.id}, ${u.id}, 'workspace', ${ws.id}::text, 'workspace.created', '{}'::jsonb)`;
  });
}

export async function workspaceRole(userId: string, workspaceId: string): Promise<Role | null> {
  const r = await sql()`select role from app.memberships where workspace_id = ${workspaceId} and user_id = ${userId} and status = 'active'`;
  return r.length ? (r[0].role as Role) : null;
}
export async function requireWorkspace(userId: string, workspaceId: string, min: Role = "member"): Promise<Role> {
  const role = await workspaceRole(userId, workspaceId);
  if (!role) throw notFound("Workspace not found.");
  if (RANK[role] < RANK[min]) throw forbidden("This needs " + min + " access to the workspace.");
  return role;
}

/** Programme visible if: workspace member AND (sharing=workspace OR creator OR admin+). */
export async function requireProgramme(userId: string, programmeId: string, write = false) {
  const r = await sql()`
    select p.*, m.role from app.programmes p
    join app.memberships m on m.workspace_id = p.workspace_id and m.user_id = ${userId} and m.status = 'active'
    where p.id = ${programmeId}`;
  if (!r.length) throw notFound("Programme not found.");
  const p = r[0];
  const admin = RANK[p.role as Role] >= RANK.admin;
  if (!(p.sharing_policy === "workspace" || p.created_by === userId || admin)) throw notFound("Programme not found.");
  if (write && !(p.created_by === userId || RANK[p.role as Role] >= RANK.facilitator)) throw forbidden();
  return p as Record<string, unknown> & { workspace_id: string; role: Role; id: string };
}

/** Session visible if programme visible AND (owner OR programme shared OR admin+). Mutations: owner or admin+. */
export async function requireSession(userId: string, sessionId: string, mode: "read" | "write" | "owner_or_admin" = "read") {
  const r = await sql()`
    select s.*, m.role, p.sharing_policy, p.created_by as programme_creator from app.sessions s
    join app.programmes p on p.id = s.programme_id
    join app.memberships m on m.workspace_id = s.workspace_id and m.user_id = ${userId} and m.status = 'active'
    where s.id = ${sessionId} and s.status <> 'deleted'`;
  if (!r.length) throw notFound("Session not found.");
  const s = r[0];
  const admin = RANK[s.role as Role] >= RANK.admin;
  const visible = s.owner_id === userId || admin || s.sharing_policy === "workspace";
  if (!visible) throw notFound("Session not found.");
  if (mode !== "read" && !(s.owner_id === userId || admin)) throw forbidden("Only the session owner or a workspace admin can do this.");
  return s as Record<string, unknown> & { id: string; workspace_id: string; programme_id: string; status: string; owner_id: string; version: number; role: Role; title: string };
}

export async function entitlement(userId: string) {
  const r = await sql()`select provider, status, current_period_end, provider_subscription_id, plan_id, checkout_url, updated_at
    from app.subscriptions where user_id = ${userId} order by updated_at desc limit 5`;
  const active = r.find((s) => ["active", "authenticated"].includes(s.status) && (!s.current_period_end || new Date(s.current_period_end).getTime() > Date.now() - 3 * 86400_000));
  return { active: !!active, subscription: active || r[0] || null };
}
export async function requireEntitlement(userId: string) {
  const e = await entitlement(userId);
  if (!e.active) throw new HttpError(402, "subscription_required", "An active CONVOSAGE subscription is required for live capture and AI features.");
  return e;
}

/** Per-workspace daily AI budget, counted from the audit trail of AI calls. */
export async function checkAiBudget(workspaceId: string, limit: number) {
  const [r] = await sql()`select count(*)::int n from app.audit_events where workspace_id = ${workspaceId} and action = 'ai.call' and occurred_at > now() - interval '1 day'`;
  if (r.n >= limit) throw new HttpError(429, "ai_budget_exceeded", "Today's AI usage limit for this workspace has been reached.");
}
