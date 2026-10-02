-- Two events the support page sign-in and the agent now write: a guest starting a session, and a caller
-- signing off (answered with the closing line and no model call, so it has no turn row of its own).
alter table public.conversation_events drop constraint if exists conversation_events_event_type_check;
alter table public.conversation_events add constraint conversation_events_event_type_check
  check (event_type in ('path_chosen','clarification_requested','identity_verified',
                        'identity_failed','escalation_triggered','declined','caller_frustrated','note',
                        'session_opened','session_recovered','session_closed','interrupted','capacity_refused',
                        'guest_session','caller_goodbye'));
