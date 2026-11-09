begin;

do $test$
declare
  draft_start timestamptz := '2099-01-02 12:00:00+00';
  archive_start timestamptz := '2099-01-03 12:00:00+00';
  published_episode public.episodes;
begin
  insert into public.episodes (producer_email, show_start_at, airing_date, description)
  values ('episode-lifecycle-publish@invalid.example', draft_start, date '2099-01-02', 'draft');

  begin
    perform public.mark_episode_published(
      'episode-lifecycle-publish@invalid.example',
      draft_start,
      date '2099-01-02'
    );
    raise exception 'Expected publishing without audio to fail.';
  exception when check_violation then null;
  end;

  begin
    perform public.mark_episode_archived(
      'episode-lifecycle-publish@invalid.example',
      date '2099-01-02'
    );
    raise exception 'Expected archival without audio to fail.';
  exception when check_violation then null;
  end;

  perform public.save_episode_metadata(
    'episode-lifecycle-publish@invalid.example',
    draft_start,
    date '2099-01-02',
    'editable draft',
    array['draft']
  );

  update public.episodes
  set audio_filename = 'publish.mp3', audio_submitted_at = now()
  where producer_email = 'episode-lifecycle-publish@invalid.example'
    and show_start_at = draft_start;

  select * into published_episode
  from public.mark_episode_published(
    'episode-lifecycle-publish@invalid.example',
    draft_start,
    date '2099-01-02'
  );

  if published_episode.published_at is null then
    raise exception 'Publishing did not lock the episode.';
  end if;

  begin
    perform public.save_episode_metadata(
      'episode-lifecycle-publish@invalid.example',
      draft_start,
      date '2099-01-02',
      'changed after publishing',
      array['changed']
    );
    raise exception 'Expected metadata editing after publishing to fail.';
  exception when unique_violation then null;
  end;

  begin
    perform public.claim_episode_media(
      'episode-lifecycle-publish@invalid.example',
      draft_start,
      date '2099-01-02',
      false,
      true,
      gen_random_uuid()
    );
    raise exception 'Expected media editing after publishing to fail.';
  exception when unique_violation then null;
  end;

  insert into public.episodes (
    producer_email,
    show_start_at,
    airing_date,
    audio_filename,
    audio_submitted_at
  ) values (
    'episode-lifecycle-archive@invalid.example',
    archive_start,
    date '2099-01-03',
    'archive.mp3',
    now()
  );

  perform public.mark_episode_archived(
    'episode-lifecycle-archive@invalid.example',
    date '2099-01-03'
  );

  begin
    update public.episodes
    set image_filename = 'changed-after-archive.jpg', image_submitted_at = now()
    where producer_email = 'episode-lifecycle-archive@invalid.example'
      and show_start_at = archive_start;
    raise exception 'Expected direct content editing after archival to fail.';
  exception when unique_violation then null;
  end;
end
$test$;

rollback;
