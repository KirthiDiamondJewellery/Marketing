# Analytics from CSV exports

Own-account metrics from CSV files, for numbers no API exposes (Instagram skip rate, completion rate) or accounts with no analytics provider.

Drop exports into `imports/analytics/` in your workspace (or set `ANALYTICS_CSV_DIR` in `.env`). Each row is one snapshot for one post. A header row is required; case, spacing and unknown columns are ignored; `,`, `;` and tab delimiters all work.

| Column | Required | Meaning | Also accepted |
|---|---|---|---|
| `post_id` | one of these two | The platform's post id | `platform_post_id`, `media_id`, `id` |
| `url` | one of these two | The post URL; the id is taken from its last path segment | `permalink`, `link` |
| `platform` | no (default instagram) | instagram, tiktok, youtube, facebook, linkedin, x, threads | `network` |
| `account` | no | Provider account id; rows for other accounts are skipped | `account_id` |
| `published_at` | no | When the post went live (ISO 8601 or YYYY-MM-DD) | `publish_time`, `posted_at`, `date` |
| `captured_at` | no | When the numbers were read (default: the file's modified time) | `exported_at` |
| `views` | no | Plays or views | `plays`, `video_views` |
| `reach`, `likes`, `comments`, `shares`, `saves`, `follows`, `profile_visits` | no | Counts; thousands separators are fine | `saved` |
| `avg_watch_time_s` | no | Average watch time in seconds | `avg_watch_time`, `average_watch_time` |
| `skip_rate` | no | Share of viewers who swiped away early: `0.42`, `42` or `42%` | `skip` |
| `completion_rate` | no | Share who watched to the end, same formats | `completion`, `watched_full` |
| `duration_s` | no | Video length in seconds | `duration` |
| `caption` | no | Caption text | |
| `clicks` | no | Link clicks from the post | `website_clicks`, `link_clicks` |
| `impressions`, `reposts` | no | Kept with the snapshot | |
| `retention` | no | Retention curve: % still watching at each step, `100\|82\|64\|…` (0–1 values work too) | `retention_curve` |
| `retention_step_s` | no | Seconds between curve points (default 1) | `retention_interval_s` |
| `retention_<N>s` | no | % still watching at second N, one column per point (e.g. `retention_3s`) | `hold_<N>s` |

Empty cells mean "unknown", never zero. Rows the importer can't use are skipped with a warning that names the line.

## Follower history

Follower counts per day feed the follower-growth chart on Insights. Drop a CSV with a `followers` column (and no post id or url column) in the import folder, or any CSV into `imports/analytics/followers/`:

| Column | Required | Meaning | Also accepted |
|---|---|---|---|
| `date` | yes | The day (YYYY-MM-DD) | `day` |
| `followers` | yes | Follower count that day | `follower_count`, `followers_count` |
| `following`, `posts` | no | Accounts followed, posts on the profile | `media_count` |
| `platform` | no | Which connected account the row belongs to | `network` |
| `account` | no | Provider account id; rows for other accounts are skipped | `account_id` |
