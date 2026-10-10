-- Run only after checking the existing chat_usage structure.
-- Assumes user_id UUID unique, messages_used integer, daily_limit integer,
-- last_reset_date date (or date-compatible text).
CREATE OR REPLACE FUNCTION public.consume_chat_quota(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_used integer; v_limit integer; v_date date;
BEGIN
  INSERT INTO public.chat_usage(user_id,messages_used,daily_limit,last_reset_date)
  VALUES (p_user_id,0,30,(now() AT TIME ZONE 'UTC')::date)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT messages_used, daily_limit, last_reset_date::date
  INTO v_used,v_limit,v_date FROM public.chat_usage
  WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing chat quota row'; END IF;
  IF v_date IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date THEN v_used := 0; END IF;
  IF v_used >= v_limit THEN
    UPDATE public.chat_usage SET messages_used=v_used,last_reset_date=(now() AT TIME ZONE 'UTC')::date
    WHERE user_id=p_user_id;
    RETURN jsonb_build_object('allowed',false,'remaining',0);
  END IF;
  UPDATE public.chat_usage SET messages_used=v_used+1,last_reset_date=(now() AT TIME ZONE 'UTC')::date
  WHERE user_id=p_user_id;
  RETURN jsonb_build_object('allowed',true,'remaining',v_limit-v_used-1);
END; $$;
REVOKE ALL ON FUNCTION public.consume_chat_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_chat_quota(uuid) TO service_role;
