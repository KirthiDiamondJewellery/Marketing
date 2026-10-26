-- Workspace-scoped queue claim. One database can hold several workspaces (a user's own plus the demo), and a
-- worker only knows how to run jobs for the workspace it loaded, so it must never claim another workspace's runs.

create or replace function aos_claim_run_ws(p_worker text, p_workspace uuid, p_agents text[] default null)
returns setof agent_runs
language plpgsql as $$
begin
  return query
  update agent_runs r
     set status = 'running', claimed_by = p_worker, heartbeat_at = now(),
         started_at = coalesce(r.started_at, now()), attempts = r.attempts + 1
   where r.id = (
     select id from agent_runs
      where status = 'queued' and run_after <= now()
        and workspace_id = p_workspace
        and (p_agents is null or agent = any(p_agents))
      order by run_after, created_at
      for update skip locked
      limit 1
   )
  returning r.*;
end;
$$;

create index if not exists agent_runs_ws_queue_idx on agent_runs (workspace_id, run_after) where status = 'queued';
create index if not exists agent_runs_ws_job_idx on agent_runs (workspace_id, job_id, created_at desc);
