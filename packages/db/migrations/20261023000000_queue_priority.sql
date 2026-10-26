-- Priority queue: work a person is waiting for runs before background work.
--
-- agent_runs.priority (higher runs first). When an insert doesn't set it, aos_agent_runs_priority() picks it:
--   110  chat messages (trigger 'chat'): someone is waiting on a reply
--   100  anything a person asked for (created_by 'user:…'), or a root 'manual' run (CLI, Run now)
--   n    a run started by another run inherits that run's priority (parent_run_id, or the run whose MCP server or
--        job code is inserting it: the `attentionos.run_id` setting on its database connection)
--     0  scheduled and other background work
-- Claiming orders by priority, then run_after (deadlines), then age. The worker also keeps a slot that only
-- priority >= 100 work may use, so a person never waits behind long background jobs.
-- Every new or re-queued run sends NOTIFY aos_runs so workers claim it at once instead of on their next poll.

alter table agent_runs add column if not exists priority int;
update agent_runs
   set priority = case when trigger = 'chat' then 110
                       when created_by like 'user:%' or (trigger = 'manual' and parent_run_id is null) then 100
                       else 0 end
 where priority is null;
alter table agent_runs alter column priority set not null;

create or replace function aos_agent_runs_priority()
returns trigger
language plpgsql as $$
declare
  v_context text;
  v_inherited int;
begin
  -- The run whose code is inserting this one (the MCP server of an agent run sets it on its connection).
  if new.parent_run_id is null then
    v_context := nullif(current_setting('attentionos.run_id', true), '');
    if v_context ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into new.parent_run_id from agent_runs where id = v_context::uuid and workspace_id = new.workspace_id;
    end if;
  end if;
  if new.priority is not null then
    return new;
  end if;
  if new.trigger = 'chat' then
    new.priority := 110;
    return new;
  end if;
  if new.created_by like 'user:%' then
    new.priority := 100;
    return new;
  end if;
  if new.parent_run_id is not null then
    select priority into v_inherited from agent_runs where id = new.parent_run_id;
  end if;
  new.priority := coalesce(v_inherited, case when new.trigger = 'manual' and new.parent_run_id is null then 100 else 0 end);
  return new;
end;
$$;

drop trigger if exists agent_runs_priority on agent_runs;
create trigger agent_runs_priority
  before insert on agent_runs
  for each row execute function aos_agent_runs_priority();

create or replace function aos_agent_runs_notify()
returns trigger
language plpgsql as $$
begin
  perform pg_notify('aos_runs', json_build_object(
    'ws', new.workspace_id,
    'priority', new.priority,
    'inMs', greatest(0, floor(extract(epoch from (new.run_after - now())) * 1000))::bigint
  )::text);
  return null;
end;
$$;

drop trigger if exists agent_runs_notify on agent_runs;
create trigger agent_runs_notify
  after insert or update of status, run_after, priority on agent_runs
  for each row when (new.status = 'queued')
  execute function aos_agent_runs_notify();

-- Claim: highest priority first, then run_after, then age. `p_min_priority` lets a worker fill its reserved slot with
-- user work only; `p_exclude_jobs` holds back heavy jobs (renders) while the worker already runs its limit of them.
drop function if exists aos_claim_run_ws(text, uuid, text[]);
create or replace function aos_claim_run_ws(
  p_worker text,
  p_workspace uuid,
  p_agents text[] default null,
  p_min_priority int default null,
  p_exclude_jobs text[] default null
)
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
        and (p_min_priority is null or priority >= p_min_priority)
        and (p_exclude_jobs is null or not (job_id = any(p_exclude_jobs)))
      order by priority desc, run_after, created_at
      for update skip locked
      limit 1
   )
  returning r.*;
end;
$$;

drop index if exists agent_runs_ws_queue_idx;
create index if not exists agent_runs_ws_priority_queue_idx on agent_runs (workspace_id, priority desc, run_after, created_at) where status = 'queued';
