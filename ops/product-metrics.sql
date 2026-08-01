WITH funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'gathering_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'response_added' THEN session_id END) AS respondents,
    COUNT(DISTINCT CASE WHEN name = 'response_added' THEN gathering_id END) AS gatherings_with_responses,
    COUNT(DISTINCT CASE WHEN name = 'response_updated' THEN session_id END) AS updaters,
    COUNT(DISTINCT CASE WHEN name = 'waitlist_joined' THEN session_id END) AS waitlisted,
    COUNT(DISTINCT CASE WHEN name = 'waitlist_promoted' THEN session_id END) AS promoted,
    COUNT(DISTINCT CASE WHEN name = 'roster_exported' THEN session_id END) AS exporters,
    COUNT(CASE WHEN name = 'roster_exported' THEN 1 END) AS exports,
    COUNT(DISTINCT CASE WHEN name = 'calendar_saved' THEN session_id END) AS calendar_users,
    COUNT(DISTINCT CASE WHEN name = 'public_gathering_viewed' THEN session_id END) AS public_viewers,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'gathering_created' AND created_at >= unixepoch() - 604800 THEN gathering_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'response_added' AND created_at >= unixepoch() - 604800 THEN session_id END) AS respondents_7d,
    COUNT(CASE WHEN is_qa = 1 THEN 1 END) AS qa_rows
  FROM product_events
  WHERE is_qa = 0 OR is_qa = 1
),
real_funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'gathering_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'response_added' THEN session_id END) AS respondents,
    COUNT(DISTINCT CASE WHEN name = 'response_added' THEN gathering_id END) AS gatherings_with_responses,
    COUNT(DISTINCT CASE WHEN name = 'response_updated' THEN session_id END) AS updaters,
    COUNT(DISTINCT CASE WHEN name = 'waitlist_joined' THEN session_id END) AS waitlisted,
    COUNT(DISTINCT CASE WHEN name = 'waitlist_promoted' THEN session_id END) AS promoted,
    COUNT(DISTINCT CASE WHEN name = 'roster_exported' THEN session_id END) AS exporters,
    COUNT(CASE WHEN name = 'roster_exported' THEN 1 END) AS exports,
    COUNT(DISTINCT CASE WHEN name = 'calendar_saved' THEN session_id END) AS calendar_users,
    COUNT(DISTINCT CASE WHEN name = 'public_gathering_viewed' THEN session_id END) AS public_viewers,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'gathering_created' AND created_at >= unixepoch() - 604800 THEN gathering_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'response_added' AND created_at >= unixepoch() - 604800 THEN session_id END) AS respondents_7d
  FROM product_events
  WHERE is_qa = 0
),
live AS (
  SELECT
    COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_gatherings,
    COUNT(CASE WHEN status = 'closed' THEN 1 END) AS closed_gatherings,
    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_gatherings
  FROM gatherings
  WHERE expires_at > unixepoch()
),
answers AS (
  SELECT
    COUNT(*) AS responses,
    COALESCE(SUM(CASE WHEN choice = 'attending' THEN party_size ELSE 0 END), 0) AS attending_seats,
    COALESCE(SUM(CASE WHEN choice = 'waitlisted' THEN party_size ELSE 0 END), 0) AS waitlisted_seats
  FROM responses
)
SELECT real_funnel.*, funnel.qa_rows, live.*, answers.*
FROM real_funnel CROSS JOIN funnel CROSS JOIN live CROSS JOIN answers;
