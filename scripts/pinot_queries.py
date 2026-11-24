"""
All 14 Pinot queries as templates. Match the HTML reference doc exactly.
Call build_queries(date_str) to get a dict of {query_id: sql} for that date.
"""

PROP = "57398d264f1c1b0016ac7a02"
PLATFORM = "('android','ios')"

ENTRY_POINTS = {
    "M": {
        "title": "Menu Bar",
        "entry_event": "MENU_OPTION_CLICK",
        "step_label": "menu_click",
        "downstream": "AND utm_medium='menu_screen_item' AND utm_campaign='au-ai-astro-talk'",
        "sub_where": "AND event_type='MENU_OPTION_CLICK' AND utm_medium='menu_screen_item' AND utm_campaign='au-ai-astro-talk'",
        "entry_case": "event_type='MENU_OPTION_CLICK'",
        "entry_events": "'MENU_OPTION_CLICK',",
    },
    "B": {
        "title": "Bottom Navigation",
        "entry_event": "BOTTOM_NAVIGATION",
        "step_label": "bottom_nav_click",
        "downstream": "AND utm_medium='bottom_bar' AND utm_campaign='au_ai_astro_talk'",
        "sub_where": "AND event_type='BOTTOM_NAVIGATION' AND utm_medium='bottom_bar' AND utm_campaign='au_ai_astro_talk'",
        "entry_case": "event_type='BOTTOM_NAVIGATION'",
        "entry_events": "'BOTTOM_NAVIGATION',",
    },
    "N": {
        "title": "Notification App Push",
        "entry_event": "AI_ASTRO_DEEPLINK_OPEN",
        "step_label": "notif_open",
        "downstream": "AND utm_medium='au_app' AND utm_campaign IN ('au-ai-astro-talk','au_ai_astro_talk') AND LOWER(utm_source) LIKE '%notification%'",
        "sub_where": "AND event_type='AI_ASTRO_DEEPLINK_OPEN' AND utm_medium='au_app' AND utm_campaign IN ('au-ai-astro-talk','au_ai_astro_talk') AND LOWER(utm_source) LIKE '%notification%'",
        "entry_case": "event_type='AI_ASTRO_DEEPLINK_OPEN'",
        "entry_events": "'AI_ASTRO_DEEPLINK_OPEN',",
    },
    "Bn": {
        "title": "Banner Story+Listing Combined",
        "entry_event": "AI_ASTRO_BANNER_CLICK",
        "step_label": "banner_click",
        "downstream": "AND flag_key='top_banner_listing' AND flag_variant LIKE '%V1_7%'",
        "sub_where": "AND event_type='AI_ASTRO_BANNER_CLICK' AND flag_key='top_banner_listing' AND flag_variant LIKE '%V1_7%'",
        "entry_case": "event_type='AI_ASTRO_BANNER_CLICK'",
        "entry_events": "'AI_ASTRO_BANNER_CLICK',",
    },
}

# event lists used inside funnel queries
_LI_EVENTS = "'PAGE_VIEW','AI_ASTRO_CALL_CLICK','AI_ASTRO_CHAT_CLICK','AI_ASTRO_CALL_CONNECTED','AI_ASTRO_CHAT_CONNECTED','AI_ASTRO_CALL_END_USER','AI_ASTRO_CHAT_END_USER','AI_ASTRO_CALL_END_TIMEUP','AI_ASTRO_CHAT_END_TIMEUP'"
_NLI_EVENTS = "'PAGE_VIEW','AI_ASTRO_CALL_CLICK','AI_ASTRO_CHAT_CLICK','AI_ASTRO_OTP_VERIFIED','AI_ASTRO_CALL_CONNECTED','AI_ASTRO_CHAT_CONNECTED','AI_ASTRO_CALL_END_USER','AI_ASTRO_CHAT_END_USER','AI_ASTRO_CALL_END_TIMEUP','AI_ASTRO_CHAT_END_TIMEUP'"


def q_smoke(date: str) -> str:
    return f"""SELECT event_type, COUNT(*) AS n, DISTINCTCOUNTHLL(user_id) AS uniq_users
FROM events
WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
  AND event_type IN ('MENU_OPTION_CLICK','BOTTOM_NAVIGATION','AI_ASTRO_DEEPLINK_OPEN',
    'AI_ASTRO_BANNER_CLICK','PAGE_VIEW','AI_ASTRO_CALL_CLICK','AI_ASTRO_CHAT_CLICK',
    'AI_ASTRO_CALL_CONNECTED','AI_ASTRO_CHAT_CONNECTED','AI_ASTRO_CALL_END_USER',
    'AI_ASTRO_CHAT_END_USER','AI_ASTRO_CALL_END_TIMEUP','AI_ASTRO_CHAT_END_TIMEUP','AI_ASTRO_OTP_VERIFIED')
GROUP BY event_type ORDER BY n DESC LIMIT 50"""


def q_identification(date: str, ep_id: str) -> str:
    ep = ENTRY_POINTS[ep_id]
    return f"""SELECT COUNT(*) AS entries, DISTINCTCOUNTHLL(user_id) AS unique_users
FROM events
WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
  AND event_type='{ep["entry_event"]}' {ep["downstream"]}
LIMIT 10"""


def q_cohort_li(date: str, ep_id: str) -> str:
    ep = ENTRY_POINTS[ep_id]
    return f"""SELECT
  DISTINCTCOUNTHLL(CASE WHEN {ep["entry_case"]} THEN user_id END) AS s1_{ep["step_label"]},
  DISTINCTCOUNTHLL(CASE WHEN event_type='PAGE_VIEW' AND screen_name='AiAstroListing' THEN user_id END) AS s2_listing_view,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CALL_CLICK' THEN user_id END) AS s3_call_click,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CHAT_CLICK' THEN user_id END) AS s3_chat_click,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CALL_CONNECTED' THEN user_id END) AS s4_call_connected,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CHAT_CONNECTED' THEN user_id END) AS s4_chat_connected,
  DISTINCTCOUNTHLL(CASE WHEN event_type IN ('AI_ASTRO_CALL_END_USER','AI_ASTRO_CALL_END_TIMEUP') THEN user_id END) AS s5_call_completed,
  DISTINCTCOUNTHLL(CASE WHEN event_type IN ('AI_ASTRO_CHAT_END_USER','AI_ASTRO_CHAT_END_TIMEUP') THEN user_id END) AS s5_chat_completed
FROM events
WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
  {ep["downstream"]}
  AND user_id IN (
    SELECT user_id FROM events
    WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
      {ep["sub_where"]} AND user_is_registered=true
  )
  AND event_type IN ({ep["entry_events"]}{_LI_EVENTS})"""


def q_cohort_nli(date: str, ep_id: str) -> str:
    ep = ENTRY_POINTS[ep_id]
    return f"""SELECT
  DISTINCTCOUNTHLL(CASE WHEN {ep["entry_case"]} THEN user_id END) AS s1_{ep["step_label"]},
  DISTINCTCOUNTHLL(CASE WHEN event_type='PAGE_VIEW' AND screen_name='AiAstroListing' THEN user_id END) AS s2_listing_view,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CALL_CLICK' THEN user_id END) AS s3_call_click,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CHAT_CLICK' THEN user_id END) AS s3_chat_click,
  DISTINCTCOUNTHLL(CASE WHEN event_type='PAGE_VIEW' AND screen_name='AiAstroLogin' THEN user_id END) AS s4_login_screen_view,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_OTP_VERIFIED' THEN user_id END) AS s5_login_success,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CALL_CONNECTED' THEN user_id END) AS s6_call_connected,
  DISTINCTCOUNTHLL(CASE WHEN event_type='AI_ASTRO_CHAT_CONNECTED' THEN user_id END) AS s6_chat_connected,
  DISTINCTCOUNTHLL(CASE WHEN event_type IN ('AI_ASTRO_CALL_END_USER','AI_ASTRO_CALL_END_TIMEUP') THEN user_id END) AS s7_call_completed,
  DISTINCTCOUNTHLL(CASE WHEN event_type IN ('AI_ASTRO_CHAT_END_USER','AI_ASTRO_CHAT_END_TIMEUP') THEN user_id END) AS s7_chat_completed
FROM events
WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
  {ep["downstream"]}
  AND user_id IN (
    SELECT user_id FROM events
    WHERE event_date_ist='{date}' AND property_id='{PROP}' AND platform IN {PLATFORM}
      {ep["sub_where"]} AND user_is_registered=false
  )
  AND event_type IN ({ep["entry_events"]}{_NLI_EVENTS})"""


def build_queries(date: str) -> dict:
    """
    Returns {query_id: {sql, requires_multi_stage}} for a given date.
    Query IDs match the HTML reference.
    """
    out = {
        "smoke": {"sql": q_smoke(date), "multi_stage": False},
    }
    for ep_id in ENTRY_POINTS:
        out[f"ep_{ep_id}_id"] = {"sql": q_identification(date, ep_id), "multi_stage": False}
        out[f"ep_{ep_id}_li"] = {"sql": q_cohort_li(date, ep_id), "multi_stage": True}
        out[f"ep_{ep_id}_nli"] = {"sql": q_cohort_nli(date, ep_id), "multi_stage": True}
    return out
