-- Scripting module: what a person's decision on a script approval does, whichever surface decided it
-- (Studio, Telegram/Discord, Claude Code, the CLI). Every surface updates the same `approvals` row, so the
-- effect lives here, next to the table, instead of in each surface.
--
--   approved -> the version becomes the approved script (older versions superseded); content is ready to film
--   rejected -> the version is rejected; the piece goes back to the ideas list unless another version is approved
--   revised  -> (a person's "request changes", with notes) the Copywriter is queued to write the next version
--
-- A paused writer run (one that saved with its run id) finishes on approve/reject and resumes on "changes".
-- System bookkeeping ("A newer version was submitted.", decided_by = 'system') and agents never trigger a rewrite.

create or replace function aos_scripting_script_decision() returns trigger
language plpgsql as $$
declare
  v_content uuid;
  v_version int;
  v_title text;
  v_key text;
begin
  if new.kind <> 'script' or new.subject_type <> 'script' or new.subject_id is null then
    return new;
  end if;
  if old.status <> 'pending' or new.status = old.status then
    return new;
  end if;

  select s.content_id, s.version, c.title into v_content, v_version, v_title
    from scripts s join content c on c.id = s.content_id and c.workspace_id = s.workspace_id
   where s.id = new.subject_id and s.workspace_id = new.workspace_id;
  if v_content is null then
    return new;
  end if;

  -- A writer run paused on this approval has nothing left to do once it's approved or rejected (the effect is
  -- applied right here), so it finishes instead of being resumed. "Changes" resumes it: that is its revision path.
  if new.status in ('approved', 'rejected') and new.run_id is not null then
    update agent_runs set status = 'succeeded', finished_at = now()
     where id = new.run_id and workspace_id = new.workspace_id and status = 'waiting_approval' and job_id = 'scripting.write-script';
  end if;

  if new.status = 'approved' then
    update scripts set status = 'superseded'
     where workspace_id = new.workspace_id and content_id = v_content and id <> new.subject_id and status in ('draft', 'approved');
    update scripts set status = 'approved'
     where workspace_id = new.workspace_id and id = new.subject_id and status = 'draft';
    update content set status = 'scripted', updated_at = now()
     where workspace_id = new.workspace_id and id = v_content and status = 'idea';

  elsif new.status = 'rejected' then
    update scripts set status = 'rejected'
     where workspace_id = new.workspace_id and id = new.subject_id and status = 'draft';
    update content set status = 'idea', updated_at = now()
     where workspace_id = new.workspace_id and id = v_content and status = 'scripted'
       and not exists (select 1 from scripts s where s.workspace_id = new.workspace_id and s.content_id = v_content and s.status = 'approved');

  elsif new.status = 'revised'
        and coalesce(new.decided_by, '') like 'user:%'
        and nullif(btrim(coalesce(new.decision_note, '')), '') is not null
        -- A run paused on this approval is resumed by the decision itself; don't start a second writer.
        and not exists (select 1 from agent_runs r where r.id = new.run_id and r.status = 'waiting_approval') then
    v_key := 'write-script:' || v_content || ':revise:' || new.ref;
    if not exists (select 1 from agent_runs where workspace_id = new.workspace_id and dedupe_key = v_key) then
      insert into agent_runs (workspace_id, agent, job_id, trigger, status, input, dedupe_key, created_by)
      values (new.workspace_id, 'copywriter', 'scripting.write-script', 'event', 'queued',
              jsonb_build_object(
                'contentId', v_content,
                'revise', jsonb_build_object('approvalRef', new.ref, 'fromVersion', v_version, 'notes', left(btrim(new.decision_note), 2000))
              ),
              v_key, new.decided_by);
      insert into agent_events (workspace_id, agent, kind, message, data)
      values (new.workspace_id, 'copywriter', 'handoff',
              'Writing version ' || (v_version + 1) || ' of “' || v_title || '” from your notes',
              jsonb_build_object('contentId', v_content, 'ref', new.ref, 'fromVersion', v_version, 'to', 'copywriter'));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists scripting_script_decision on approvals;
create trigger scripting_script_decision
  after update of status on approvals
  for each row
  when (new.kind = 'script' and new.subject_type = 'script' and old.status = 'pending' and new.status <> 'pending')
  execute function aos_scripting_script_decision();
